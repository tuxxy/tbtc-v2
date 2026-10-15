/* eslint-disable no-await-in-loop, no-restricted-syntax */
// Evaluate each fixed interop vector and rejection case sequentially.
import { ethers } from "hardhat"
import { expect } from "chai"
import vectors from "../data/frost/intent-v2.json"

describe("FROST K-04 intent v2 contract encoding", () => {
  async function fixture(index = 0) {
    const verifier = await (
      await ethers.getContractFactory("FrostReservationCertificateFixture")
    ).deploy()
    const v = vectors[index]
    const reservation = {
      walletId: `0x${v.walletID}`,
      descriptorHash: `0x${v.descriptorHash}`,
      generation: v.generation,
      stateVersion: v.stateVersion,
      intentCommitment: `0x${v.commitment}`,
      requestIdsHash: ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ["bytes32[]"],
          [v.requests.map((r) => `0x${r.id}`)]
        )
      ),
      conflictTxHash: `0x${v.conflictHash}`,
      conflictOutputIndex: v.conflictIndex,
      minimumFee: v.fees[0],
      maximumFee: v.fees[1],
      maximumSatPerVByte: v.fees[2],
      validUntilBlock: 1000000,
    }
    const requests = v.requests.map((r) => ({
      id: `0x${r.id}`,
      value: r.value,
      script: `0x${r.script}`,
    }))
    return { verifier, v, reservation, requests }
  }

  it("matches both fixed Go/TypeScript commitments including wide uint64 fields", async () => {
    for (let i = 0; i < vectors.length; i += 1) {
      const f = await fixture(i)
      expect(ethers.utils.sha256(`0x${f.v.preimage}`)).to.equal(
        `0x${f.v.commitment}`
      )
      expect(
        await f.verifier.intentCommitment(
          `0x${f.v.snapshot}`,
          `0x${f.v.genesis}`,
          f.reservation,
          f.requests
        )
      ).to.equal(`0x${f.v.commitment}`)
    }
  })

  it("binds recipient value and script bytes", async () => {
    const f = await fixture()
    for (const request of [
      { ...f.requests[0], value: "10001" },
      {
        ...f.requests[0],
        script: "0x00140000000000000000000000000000000000000000",
      },
    ]) {
      expect(
        await f.verifier.intentCommitment(
          `0x${f.v.snapshot}`,
          `0x${f.v.genesis}`,
          f.reservation,
          [request]
        )
      ).not.to.equal(`0x${f.v.commitment}`)
    }
  })

  it("encodes the maximum 64-request P2WSH batch below the helper gas ceiling", async () => {
    const f = await fixture()
    const requests = Array.from({ length: 64 }, (_, i) => ({
      id: ethers.utils.hexZeroPad(ethers.utils.hexlify(i + 1), 32),
      value: "10000",
      script: `0x0020${"ab".repeat(32)}`,
    }))
    const gas = await f.verifier.estimateGas.intentCommitment(
      `0x${f.v.snapshot}`,
      `0x${f.v.genesis}`,
      f.reservation,
      requests
    )
    expect(gas.toNumber()).to.be.lessThan(4000000)
    console.log(`64-request encoder gas: ${gas.toString()}`)
    const number = (value: string | number, width: number) =>
      ethers.utils.hexZeroPad(ethers.BigNumber.from(value).toHexString(), width)
    const preimage = ethers.utils.concat([
      ethers.utils.toUtf8Bytes("keep-core/frost/signing-intent/v2/"),
      "0x02",
      `0x${f.v.snapshot}`,
      f.reservation.walletId,
      f.reservation.descriptorHash,
      `0x${f.v.genesis}`,
      "0x01",
      number(f.reservation.generation, 8),
      number(f.reservation.stateVersion, 8),
      number(requests.length, 2),
      ...requests.flatMap((r) => [
        r.id,
        number(r.value, 8),
        number(ethers.utils.arrayify(r.script).length, 2),
        r.script,
      ]),
      f.reservation.conflictTxHash,
      number(f.reservation.conflictOutputIndex, 4),
      number(f.reservation.minimumFee, 8),
      number(f.reservation.maximumFee, 8),
      number(f.reservation.maximumSatPerVByte, 8),
    ])
    expect(
      await f.verifier.intentCommitment(
        `0x${f.v.snapshot}`,
        `0x${f.v.genesis}`,
        f.reservation,
        requests
      )
    ).to.equal(ethers.utils.sha256(preimage))
    // Whole admission gas, including per-request state writes, remains a C-04 exit check.
    await expect(
      f.verifier.intentCommitment(
        `0x${f.v.snapshot}`,
        `0x${f.v.genesis}`,
        f.reservation,
        requests.concat(requests[0])
      )
    ).to.be.revertedWith("FROST intent domain")
  })

  it("rejects nonpositive values and unsupported recipient scripts", async () => {
    const f = await fixture()
    for (const requests of [
      [],
      [{ ...f.requests[0], value: "0" }],
      [{ ...f.requests[0], value: "2100000000000001" }],
      [{ ...f.requests[0], script: `0x5120${f.v.outputKey}` }],
      [{ ...f.requests[0], script: "0x0014" }],
    ]) {
      await expect(
        f.verifier.intentCommitment(
          `0x${f.v.snapshot}`,
          `0x${f.v.genesis}`,
          f.reservation,
          requests
        )
      ).to.be.reverted
    }
  })
})
