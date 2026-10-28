/* eslint-disable no-await-in-loop, no-restricted-syntax */
// Keep each rejection assertion adjacent to its certificate input.
import { ethers, network } from "hardhat"
import { expect } from "chai"
import vectors from "../data/frost/intent-v2.json"

const descriptorType =
  "tuple(uint8 scheme,uint8 profile,uint256 chainId,address registry,uint64 epoch,uint32[] members,address[] operators,uint16 threshold,bytes32 snowfallDescriptor,bytes32 outputKey)"
const reservationType =
  "tuple(bytes32 walletId,bytes32 descriptorHash,uint64 generation,uint64 stateVersion,bytes32 intentCommitment,bytes32 requestIdsHash,bytes32 conflictTxHash,uint32 conflictOutputIndex,uint64 minimumFee,uint64 maximumFee,uint64 maximumSatPerVByte,uint64 validUntilBlock)"

describe("FROST reservation operator certificates", () => {
  async function fixture() {
    const [bridge, a, b, c, foreign] = await ethers.getSigners()
    const verifier = await (
      await ethers.getContractFactory("FrostReservationCertificateFixture")
    ).deploy()
    const { chainId } = await ethers.provider.getNetwork()
    const q = `0x${vectors[0].outputKey}`
    const descriptor = {
      scheme: 2,
      profile: 1,
      chainId,
      registry: bridge.address,
      epoch: 1,
      members: [11, 22, 33],
      operators: [a.address, b.address, c.address],
      threshold: 2,
      snowfallDescriptor: ethers.utils.id("snowfall"),
      outputKey: q,
    }
    const reservation = {
      walletId: ethers.utils.keccak256(
        ethers.utils.concat([ethers.utils.id("tbtc-v2/frost-wallet-id/v1"), q])
      ),
      descriptorHash: ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ["bytes32", descriptorType],
          [ethers.utils.id("tbtc-v2/frost-descriptor/v1"), descriptor]
        )
      ),
      generation: 1,
      stateVersion: 1,
      intentCommitment: ethers.utils.id("exact binary intent"),
      requestIdsHash: ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ["bytes32[]"],
          [[ethers.utils.id("request")]]
        )
      ),
      conflictTxHash: `0x${vectors[0].conflictHash}`,
      conflictOutputIndex: vectors[0].conflictIndex,
      minimumFee: 100,
      maximumFee: 2000,
      maximumSatPerVByte: 20,
      validUntilBlock: (await ethers.provider.getBlockNumber()) + 1000,
    }
    const plan = {
      snapshot: `0x${vectors[0].snapshot}`,
      genesis: `0x${vectors[0].genesis}`,
      requests: vectors[0].requests.map((r) => ({
        id: `0x${r.id}`,
        value: r.value,
        script: `0x${r.script}`,
      })),
    }
    const derived = await verifier.derive(reservation, plan)
    reservation.intentCommitment = derived.intentCommitment
    reservation.requestIdsHash = derived.requestIdsHash
    const digest = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["bytes32", "uint256", "address", reservationType],
        [
          ethers.utils.id("tbtc-v2/frost-redemption-reservation/v2"),
          chainId,
          bridge.address,
          reservation,
        ]
      )
    )
    expect(await verifier.digest(bridge.address, reservation)).to.equal(digest)
    const signatures = ethers.utils.concat(
      await Promise.all(
        [a, b].map((s) => s.signMessage(ethers.utils.arrayify(digest)))
      )
    )
    const validate = (
      r = reservation,
      seats = [1, 2],
      sig = signatures,
      d = descriptor,
      target = bridge.address,
      data = plan
    ) => verifier.validate(target, d, r, data, seats, sig)
    return {
      validate,
      verifier,
      bridge,
      a,
      b,
      foreign,
      descriptor,
      reservation,
      digest,
      signatures,
      plan,
    }
  }

  it("accepts a threshold certificate with independent ABI digest", async () => {
    expect(await (await fixture()).validate()).to.equal(true)
  })

  it("derives both bindings before validating a certificate and rejects changed plan data", async () => {
    const f = await fixture()
    expect(await f.validate()).to.equal(true)
    for (const plan of [
      { ...f.plan, snapshot: ethers.utils.id("different snapshot") },
      { ...f.plan, genesis: ethers.utils.id("different network") },
      { ...f.plan, requests: [{ ...f.plan.requests[0], value: "10001" }] },
      {
        ...f.plan,
        requests: [
          {
            ...f.plan.requests[0],
            script: "0x00140000000000000000000000000000000000000000",
          },
        ],
      },
    ]) {
      expect(
        await f.validate(
          f.reservation,
          [1, 2],
          f.signatures,
          f.descriptor,
          f.bridge.address,
          plan
        )
      ).to.equal(false)
    }
  })

  it("derives fresh bindings and refuses mismatches without rewriting the caller tuple", async () => {
    const f = await fixture()
    const encode = (reservation: unknown) =>
      ethers.utils.defaultAbiCoder.encode([reservationType], [reservation])
    for (const update of [
      { intentCommitment: ethers.utils.id("wrong supplied intent") },
      { requestIdsHash: ethers.utils.id("wrong supplied request IDs") },
    ]) {
      const reservation = { ...f.reservation, ...update }
      const before = encode(reservation)
      const derived = await f.verifier.derivePreservingInput(
        reservation,
        f.plan
      )
      expect(encode(derived.original)).to.equal(before)
      expect(derived.derived.intentCommitment).to.equal(
        f.reservation.intentCommitment
      )
      expect(derived.derived.requestIdsHash).to.equal(
        f.reservation.requestIdsHash
      )
      const digest = await f.verifier.digest(f.bridge.address, reservation)
      const signatures = ethers.utils.concat(
        await Promise.all(
          [f.a, f.b].map((signer) =>
            signer.signMessage(ethers.utils.arrayify(digest))
          )
        )
      )
      const checked = await f.verifier.validatePreservingInput(
        f.bridge.address,
        f.descriptor,
        reservation,
        f.plan,
        [1, 2],
        signatures
      )
      expect(checked.accepted).to.equal(false)
      expect(encode(checked.original)).to.equal(before)
    }
    const valid = await f.verifier.validatePreservingInput(
      f.bridge.address,
      f.descriptor,
      f.reservation,
      f.plan,
      [1, 2],
      f.signatures
    )
    expect(valid.accepted).to.equal(true)
    expect(encode(valid.original)).to.equal(encode(f.reservation))
  })

  it("reverts on malformed Plan/request domains and returns false on binding mismatches", async () => {
    const f = await fixture()
    const malformed = [
      { plan: { ...f.plan, requests: [] }, reason: "FROST intent domain" },
      {
        plan: { ...f.plan, snapshot: ethers.constants.HashZero },
        reason: "FROST intent domain",
      },
      {
        plan: { ...f.plan, genesis: ethers.constants.HashZero },
        reason: "FROST intent domain",
      },
      {
        plan: {
          ...f.plan,
          requests: Array(256).fill(f.plan.requests[0]),
        },
        reason: "FROST intent domain",
      },
      {
        plan: {
          ...f.plan,
          requests: [{ ...f.plan.requests[0], id: ethers.constants.HashZero }],
        },
        reason: "FROST intent request",
      },
      {
        plan: { ...f.plan, requests: [{ ...f.plan.requests[0], value: "0" }] },
        reason: "FROST intent request",
      },
      {
        plan: {
          ...f.plan,
          requests: [{ ...f.plan.requests[0], value: "2100000000000001" }],
        },
        reason: "FROST intent request",
      },
      {
        plan: {
          ...f.plan,
          requests: [{ ...f.plan.requests[0], script: "0x0014" }],
        },
        reason: "FROST intent request",
      },
    ]
    for (const { plan, reason } of malformed) {
      await expect(
        f.validate(
          f.reservation,
          [1, 2],
          f.signatures,
          f.descriptor,
          f.bridge.address,
          plan
        )
      ).to.be.revertedWith(reason)
    }
    expect(
      await f.validate({
        ...f.reservation,
        requestIdsHash: ethers.utils.id("well-formed mismatch"),
      })
    ).to.equal(false)
    // Early certificate checks can refuse before malformed Plan derivation.
    expect(
      await f.validate(
        { ...f.reservation, generation: 0 },
        [1, 2],
        f.signatures,
        f.descriptor,
        f.bridge.address,
        { ...f.plan, requests: [] }
      )
    ).to.equal(false)
  })

  it("rejects a correctly signed certificate after its inclusive block deadline", async () => {
    const f = await fixture()
    const reservation = {
      ...f.reservation,
      validUntilBlock: (await ethers.provider.getBlockNumber()) + 2,
    }
    const digest = await f.verifier.digest(f.bridge.address, reservation)
    const signatures = ethers.utils.concat(
      await Promise.all(
        [f.a, f.b].map((s) => s.signMessage(ethers.utils.arrayify(digest)))
      )
    )
    await network.provider.send("evm_mine")
    await network.provider.send("evm_mine")
    expect(await f.validate(reservation, [1, 2], signatures)).to.equal(true)
    await network.provider.send("evm_mine")
    expect(await f.validate(reservation, [1, 2], signatures)).to.equal(false)
  })

  it("has a stable logical reservation ID independent of certificate renewal", async () => {
    const f = await fixture()
    const expected = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        [
          "bytes32",
          "uint256",
          "address",
          "bytes32",
          "bytes32",
          "uint64",
          "uint64",
          "bytes32",
        ],
        [
          ethers.utils.id("tbtc-v2/frost-reservation-id/v1"),
          f.descriptor.chainId,
          f.bridge.address,
          f.reservation.walletId,
          f.reservation.descriptorHash,
          f.reservation.generation,
          f.reservation.stateVersion,
          f.reservation.intentCommitment,
        ]
      )
    )
    expect(
      await f.verifier.reservationId(f.bridge.address, f.reservation)
    ).to.equal(expected)
    expect(
      await f.verifier.reservationId(f.bridge.address, {
        ...f.reservation,
        validUntilBlock: f.reservation.validUntilBlock + 1,
      })
    ).to.equal(expected)
    expect(
      await f.verifier.reservationId(f.bridge.address, {
        ...f.reservation,
        generation: 2,
      })
    ).not.to.equal(expected)
    expect(
      await f.verifier.reservationId(f.foreign.address, f.reservation)
    ).not.to.equal(expected)
  })

  it("rejects correctly signed malformed descriptor shapes", async () => {
    const f = await fixture()
    const descriptors = [
      { ...f.descriptor, members: [0, 22, 33] },
      {
        ...f.descriptor,
        operators: [
          ethers.constants.AddressZero,
          f.b.address,
          f.foreign.address,
        ],
      },
      { ...f.descriptor, threshold: 1 },
      { ...f.descriptor, threshold: 4 },
      { ...f.descriptor, operators: [f.a.address, f.b.address] },
      { ...f.descriptor, scheme: 1 },
      { ...f.descriptor, profile: 2 },
      {
        ...f.descriptor,
        members: Array.from({ length: 101 }, (_, i) => i + 1),
        operators: Array(101).fill(f.a.address),
        threshold: 51,
      },
    ]
    for (const descriptor of descriptors) {
      const reservation = {
        ...f.reservation,
        descriptorHash: ethers.utils.keccak256(
          ethers.utils.defaultAbiCoder.encode(
            ["bytes32", descriptorType],
            [ethers.utils.id("tbtc-v2/frost-descriptor/v1"), descriptor]
          )
        ),
      }
      const derived = await f.verifier.derive(reservation, f.plan)
      reservation.intentCommitment = derived.intentCommitment
      reservation.requestIdsHash = derived.requestIdsHash
      const digest = await f.verifier.digest(f.bridge.address, reservation)
      const seats =
        descriptor.members.length === 101
          ? Array.from({ length: 51 }, (_, i) => i + 1)
          : [1, 2]
      const signatures =
        descriptor.members.length === 101
          ? ethers.utils.concat(
              Array(51).fill(
                await f.a.signMessage(ethers.utils.arrayify(digest))
              )
            )
          : ethers.utils.concat(
              await Promise.all(
                [f.a, f.b].map((s) =>
                  s.signMessage(ethers.utils.arrayify(digest))
                )
              )
            )
      expect(
        await f.validate(reservation, seats, signatures, descriptor)
      ).to.equal(false)
    }
  })

  it("binds every reservation field and the Bridge deployment", async () => {
    const f = await fixture()
    for (const field of Object.keys(f.reservation)) {
      const value = (f.reservation as any)[field]
      const changed =
        typeof value === "number"
          ? value + 1
          : ethers.utils.id(`changed ${field}`)
      expect(
        await f.validate({ ...f.reservation, [field]: changed }),
        field
      ).to.equal(false)
    }
    expect(
      await f.validate(
        f.reservation,
        [1, 2],
        f.signatures,
        f.descriptor,
        f.foreign.address
      )
    ).to.equal(false)
  })

  it("rejects repeated, unordered, out-of-range and insufficient seats", async () => {
    const f = await fixture()
    for (const seats of [[1, 1], [2, 1], [0, 2], [1, 4], [1], []]) {
      expect(await f.validate(f.reservation, seats)).to.equal(false)
    }
  })

  it("rejects malformed signatures and signatures from another seat or actor", async () => {
    const f = await fixture()
    const foreign = await f.foreign.signMessage(ethers.utils.arrayify(f.digest))
    for (const sig of [
      "0x",
      ethers.utils.hexlify(f.signatures).slice(0, -2),
      ethers.utils.concat([foreign, foreign]),
      ethers.utils.concat([
        await f.b.signMessage(ethers.utils.arrayify(f.digest)),
        await f.a.signMessage(ethers.utils.arrayify(f.digest)),
      ]),
    ]) {
      expect(await f.validate(f.reservation, [1, 2], sig)).to.equal(false)
    }
  })

  it("counts distinct selected seats when one operator holds multiple seats", async () => {
    const f = await fixture()
    const descriptor = {
      ...f.descriptor,
      operators: [f.a.address, f.a.address, f.b.address],
    }
    const reservation = {
      ...f.reservation,
      descriptorHash: ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ["bytes32", descriptorType],
          [ethers.utils.id("tbtc-v2/frost-descriptor/v1"), descriptor]
        )
      ),
    }
    const derived = await f.verifier.derive(reservation, f.plan)
    reservation.intentCommitment = derived.intentCommitment
    reservation.requestIdsHash = derived.requestIdsHash
    const digest = await f.verifier.digest(f.bridge.address, reservation)
    const signature = await f.a.signMessage(ethers.utils.arrayify(digest))
    expect(
      await f.validate(
        reservation,
        [1, 2],
        ethers.utils.concat([signature, signature]),
        descriptor
      )
    ).to.equal(true)
    expect(
      await f.validate(
        reservation,
        [1, 1],
        ethers.utils.concat([signature, signature]),
        descriptor
      )
    ).to.equal(false)
  })

  it("refuses correctly signed invalid fee and identity domains", async () => {
    const f = await fixture()
    for (const update of [
      { generation: 0 },
      { stateVersion: 0 },
      { intentCommitment: ethers.constants.HashZero },
      { requestIdsHash: ethers.constants.HashZero },
      { conflictTxHash: ethers.constants.HashZero },
      { walletId: ethers.constants.HashZero },
      { descriptorHash: ethers.constants.HashZero },
      { minimumFee: 0 },
      { minimumFee: 2001 },
      { maximumFee: 2100000000000001 },
      { maximumSatPerVByte: 0 },
      { maximumSatPerVByte: 2100000000000001 },
    ]) {
      const reservation = { ...f.reservation, ...update }
      const digest = await f.verifier.digest(f.bridge.address, reservation)
      const signatures = ethers.utils.concat(
        await Promise.all(
          [f.a, f.b].map((s) => s.signMessage(ethers.utils.arrayify(digest)))
        )
      )
      expect(await f.validate(reservation, [1, 2], signatures)).to.equal(false)
    }
  })

  it("refuses a correctly signed descriptor from another chain", async () => {
    const f = await fixture()
    const descriptor = { ...f.descriptor, chainId: f.descriptor.chainId + 1 }
    const reservation = {
      ...f.reservation,
      descriptorHash: ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ["bytes32", descriptorType],
          [ethers.utils.id("tbtc-v2/frost-descriptor/v1"), descriptor]
        )
      ),
    }
    const digest = await f.verifier.digest(f.bridge.address, reservation)
    const signatures = ethers.utils.concat(
      await Promise.all(
        [f.a, f.b].map((s) => s.signMessage(ethers.utils.arrayify(digest)))
      )
    )
    expect(
      await f.validate(reservation, [1, 2], signatures, descriptor)
    ).to.equal(false)
  })
})
