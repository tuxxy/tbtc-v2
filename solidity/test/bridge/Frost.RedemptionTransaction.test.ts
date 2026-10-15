/* eslint-disable no-await-in-loop, no-restricted-syntax, no-bitwise */
// Independent Bitcoin wire encoding uses explicit BigInt bit widths/endian order.
import { ethers } from "hardhat"
import { expect } from "chai"
import vectors from "../data/frost/intent-v2.json"

type Input = { txHash: string; txOutputIndex: number; txOutputValue: string }
type Payee = { id: string; value: string; script: string }
type Output = { value: string; script: string }
const hex = (b: Buffer) => `0x${b.toString("hex")}`
const bytes = (s: string) => Buffer.from(s.replace(/^0x/, ""), "hex")
const le = (value: string | number | bigint, width: number) => {
  let n = BigInt(value)
  const b = Buffer.alloc(width)
  if (n < 0n || n >= 1n << BigInt(width * 8)) throw Error("width")
  for (let i = 0; i < width; i += 1) {
    b[i] = Number(n & 255n)
    n >>= 8n
  }
  return b
}
const compact = (n: number) =>
  n < 253 ? le(n, 1) : Buffer.concat([Buffer.from([253]), le(n, 2)])
const key = `0x${vectors[0].outputKey}`
const changeScript = `0x5120${vectors[0].outputKey}`
const recipient = `0x${vectors[0].requests[0].script}`
const patch = (s: string, start: number, length: number, replace: Buffer) =>
  hex(
    Buffer.concat([
      bytes(s).subarray(0, start),
      replace,
      bytes(s).subarray(start + length),
    ])
  )
const transaction = (
  inputs: Input[],
  outputs: Output[],
  sequence = 0xfffffffd,
  locktime = 0
) => ({
  version: "0x02000000",
  inputVector: hex(
    Buffer.concat([
      compact(inputs.length),
      ...inputs.flatMap((i) => [
        bytes(i.txHash),
        le(i.txOutputIndex, 4),
        Buffer.from([0]),
        le(sequence, 4),
      ]),
    ])
  ),
  outputVector: hex(
    Buffer.concat([
      compact(outputs.length),
      ...outputs.flatMap((o) => [
        le(o.value, 8),
        compact(bytes(o.script).length),
        bytes(o.script),
      ]),
    ])
  ),
  locktime: hex(le(locktime, 4)),
})
type Info = ReturnType<typeof transaction>
const raw = (tx: Info) =>
  Buffer.concat([
    bytes(tx.version),
    bytes(tx.inputVector),
    bytes(tx.outputVector),
    bytes(tx.locktime),
  ])
const independentSnapshot = (tx: Info, inputs: Input[], q = key) =>
  ethers.utils.sha256(
    Buffer.concat([
      Buffer.from("keep-core/taproot-snapshot/v1"),
      bytes(q),
      raw(tx),
      ...inputs.flatMap((i) => [
        le(i.txOutputValue, 8),
        compact(34),
        bytes(`0x5120${q.slice(2)}`),
      ]),
    ])
  )
const independentVsize = (tx: Info, count: number) => {
  const signed = Buffer.concat([
    bytes(tx.version),
    Buffer.from([0, 1]),
    bytes(tx.inputVector),
    bytes(tx.outputVector),
    ...Array.from({ length: count }, () =>
      Buffer.concat([Buffer.from([1, 64]), Buffer.alloc(64)])
    ),
    bytes(tx.locktime),
  ])
  return Math.ceil((3 * raw(tx).length + signed.length) / 4)
}

describe("FROST canonical redemption/cancellation transactions", () => {
  async function fixture() {
    const validator = await (
      await ethers.getContractFactory("FrostRedemptionTransactionFixture")
    ).deploy()
    const inputs = [
      {
        txHash: `0x${vectors[0].conflictHash}`,
        txOutputIndex: 0,
        txOutputValue: "100000",
      },
    ]
    const requests = vectors[0].requests.map((r) => ({
      id: `0x${r.id}`,
      value: r.value,
      script: `0x${r.script}`,
    }))
    const outputs = [
      ...requests.map((r) => ({ value: r.value, script: r.script })),
      { value: "89000", script: changeScript },
    ]
    const tx = transaction(inputs, outputs)
    const validate = (
      info = tx,
      recognized = inputs,
      payees = requests,
      q = key
    ) => validator.validateRedemption(info, q, recognized, payees)
    return { validator, inputs, requests, outputs, tx, validate }
  }

  it("matches both frozen Go transaction snapshots, internal txid and signed vsize", async () => {
    const f = await fixture()
    for (const v of vectors) {
      expect(hex(raw(f.tx))).to.equal(`0x${v.rawTransaction}`)
      const result = await f.validate()
      expect(result.snapshot).to.equal(`0x${v.snapshot}`)
      expect(result.snapshot).to.equal(independentSnapshot(f.tx, f.inputs))
      expect(result.txHash).to.equal(
        ethers.utils.sha256(ethers.utils.sha256(raw(f.tx)))
      )
      expect(result.virtualSize.toNumber()).to.equal(independentVsize(f.tx, 1))
      expect(result.fee.toString()).to.equal("1000")
      expect(result.changeValue.toString()).to.equal("89000")
      expect(result.changeIndex).to.equal(1)
    }
  })

  it("matches independent multi-input snapshots with exact recognized order and all recipient shapes", async () => {
    const f = await fixture()
    const inputs = Array.from({ length: 4 }, (_, i) => ({
      txHash: ethers.utils.id(`funding-${i}`),
      txOutputIndex: i,
      txOutputValue: String(100000 + i),
    }))
    const scripts = [
      recipient,
      `0xa914${"11".repeat(20)}87`,
      `0x76a914${"22".repeat(20)}88ac`,
      `0x0020${"33".repeat(32)}`,
    ]
    const requests = scripts.map((script, i) => ({
      id: ethers.utils.id(`request-${i}`),
      value: "10000",
      script,
    }))
    const tx = transaction(
      inputs,
      [...requests, { value: "359006", script: changeScript }],
      0xfffffffe,
      500
    )
    const result = await f.validate(tx, inputs, requests)
    expect(result.snapshot).to.equal(independentSnapshot(tx, inputs))
    expect(result.virtualSize.toNumber()).to.equal(
      independentVsize(tx, inputs.length)
    )
    expect(result.fee.toString()).to.equal("1000")
    await expect(
      f.validate(tx, inputs.slice().reverse(), requests)
    ).to.be.revertedWith("FROST input outpoint")
    await expect(
      f.validate(tx, inputs, requests.slice().reverse())
    ).to.be.revertedWith("FROST output script")
  })

  it("rejects a changed byte at every word and tail position for every recipient shape", async () => {
    const f = await fixture()
    const scripts = [
      recipient,
      `0xa914${"11".repeat(20)}87`,
      `0x76a914${"22".repeat(20)}88ac`,
      `0x0020${"33".repeat(32)}`,
    ]
    for (const script of scripts) {
      const requests = [{ ...f.requests[0], script }]
      const outputs = [{ ...f.outputs[0], script }, f.outputs[1]]
      await f.validate(transaction(f.inputs, outputs), f.inputs, requests)
      const original = ethers.utils.arrayify(script)
      for (let position = 0; position < original.length; position++) {
        const changed = original.slice()
        changed[position] ^= 1
        await expect(
          f.validate(
            transaction(f.inputs, [
              { ...outputs[0], script: ethers.utils.hexlify(changed) },
              outputs[1],
            ]),
            f.inputs,
            requests
          )
        ).to.be.revertedWith("FROST output script")
      }
    }
  })

  it("requires exact ordered input outpoints, values and nonduplicate identities", async () => {
    const f = await fixture()
    for (const update of [
      { txHash: ethers.utils.id("foreign") },
      { txOutputIndex: 1 },
      { txHash: ethers.constants.HashZero },
      { txOutputValue: "0" },
      { txOutputValue: "2100000000000001" },
    ]) {
      await expect(f.validate(f.tx, [{ ...f.inputs[0], ...update }])).to.be
        .reverted
    }
    // A different recognized value changes the snapshot and fee; only custody storage authenticates it.
    const supplied = [{ ...f.inputs[0], txOutputValue: "100001" }]
    const changed = await f.validate(f.tx, supplied)
    expect(changed.snapshot).not.to.equal((await f.validate()).snapshot)
    expect(changed.fee.toString()).to.equal("1001")
    const duplicate = [f.inputs[0], f.inputs[0]]
    await expect(
      f.validate(transaction(duplicate, f.outputs), duplicate)
    ).to.be.revertedWith("FROST duplicate input")
    const distinct = [f.inputs[0], { ...f.inputs[0], txOutputIndex: 1 }]
    expect(
      (
        await f.validate(
          transaction(distinct, [
            { ...f.outputs[0] },
            { value: "189000", script: changeScript },
          ]),
          distinct
        )
      ).fee.toString()
    ).to.equal("1000")
  })

  it("resolves duplicate-table hash collisions and wraparound without conflating outpoints", async () => {
    const f = await fixture()
    const colliders: Input[] = []
    for (let i = 0; colliders.length < 2 && i < 10000; i += 1) {
      const txHash = ethers.utils.id(`collision-${i}`)
      const bucket = ethers.BigNumber.from(
        ethers.utils.solidityKeccak256(["bytes32", "uint32"], [txHash, 0])
      ).mod(512)
      if (bucket.eq(511)) {
        colliders.push({ txHash, txOutputIndex: 0, txOutputValue: "100000" })
      }
    }
    expect(colliders.length).to.equal(2)
    const outputs = [f.outputs[0], { value: "189000", script: changeScript }]
    expect(
      (
        await f.validate(transaction(colliders, outputs), colliders)
      ).fee.toString()
    ).to.equal("1000")
    const repeated = [...colliders, colliders[0]]
    await expect(
      f.validate(transaction(repeated, outputs), repeated)
    ).to.be.revertedWith("FROST duplicate input")
  })

  it("rejects empty/oversize counts and every truncated output component", async () => {
    const f = await fixture()
    await expect(f.validate(f.tx, [])).to.be.revertedWith("FROST input count")
    for (const count of ["00", "fd0101", "ffffffffffffffffff"]) {
      await expect(
        f.validate({ ...f.tx, inputVector: `0x${count}` })
      ).to.be.revertedWith("FROST input count")
      await expect(
        f.validate({ ...f.tx, outputVector: `0x${count}` })
      ).to.be.revertedWith("FROST output count")
    }
    for (const length of [
      0,
      1,
      8,
      9,
      10,
      30,
      bytes(f.tx.outputVector).length - 1,
    ]) {
      await expect(
        f.validate({
          ...f.tx,
          outputVector: hex(bytes(f.tx.outputVector).subarray(0, length)),
        })
      ).to.be.reverted
    }
  })

  it("requires version 2, empty scriptSig and fully present input bytes", async () => {
    const f = await fixture()
    for (const version of ["0x01000000", "0x03000000", "0x00000002"])
      await expect(f.validate({ ...f.tx, version })).to.be.revertedWith(
        "FROST transaction version"
      )
    await expect(
      f.validate({
        ...f.tx,
        inputVector: patch(f.tx.inputVector, 37, 1, Buffer.from([1, 0])),
      })
    ).to.be.revertedWith("FROST unsigned input")
    for (const length of [0, 1, 31, 36, 37, 38, 41])
      await expect(
        f.validate({
          ...f.tx,
          inputVector: hex(bytes(f.tx.inputVector).subarray(0, length)),
        })
      ).to.be.reverted
    await expect(
      f.validate({ ...f.tx, inputVector: `${f.tx.inputVector}00` })
    ).to.be.revertedWith("FROST input trailing data")
    await expect(
      f.validate({ ...f.tx, outputVector: `${f.tx.outputVector}00` })
    ).to.be.revertedWith("FROST output trailing data")
  })

  it("refuses noncanonical CompactSize for counts and scripts and dishonest large lengths", async () => {
    const f = await fixture()
    for (const prefix of [
      Buffer.from("fd0100", "hex"),
      Buffer.from("fe01000000", "hex"),
      Buffer.from("ff0100000000000000", "hex"),
    ]) {
      await expect(
        f.validate({
          ...f.tx,
          inputVector: patch(f.tx.inputVector, 0, 1, prefix),
        })
      ).to.be.revertedWith("FROST noncanonical CompactSize")
    }
    await expect(
      f.validate({
        ...f.tx,
        outputVector: patch(
          f.tx.outputVector,
          0,
          1,
          Buffer.from("fd0200", "hex")
        ),
      })
    ).to.be.revertedWith("FROST noncanonical CompactSize")
    await expect(
      f.validate({
        ...f.tx,
        inputVector: patch(
          f.tx.inputVector,
          37,
          1,
          Buffer.from("fd0000", "hex")
        ),
      })
    ).to.be.revertedWith("FROST noncanonical CompactSize")
    await expect(
      f.validate({
        ...f.tx,
        outputVector: patch(
          f.tx.outputVector,
          9,
          1,
          Buffer.from("fd1600", "hex")
        ),
      })
    ).to.be.revertedWith("FROST noncanonical CompactSize")
    for (const prefix of ["fd", "fe0100", "ff01000000", "ffffffffffffffffff"])
      await expect(
        f.validate({
          ...f.tx,
          outputVector: patch(
            f.tx.outputVector,
            9,
            1,
            Buffer.from(prefix, "hex")
          ),
        })
      ).to.be.reverted
    await expect(
      f.validate({ ...f.tx, inputVector: "0x0001" })
    ).to.be.revertedWith("FROST input count")
  })

  it("requires exact recipient values/scripts and one positive exact-Q change last", async () => {
    const f = await fixture()
    for (const outputs of [
      [],
      [f.outputs[0]],
      f.outputs.slice().reverse(),
      [...f.outputs, f.outputs[1]],
      [{ ...f.outputs[0], value: "10001" }, f.outputs[1]],
      [{ ...f.outputs[0], script: `0x0014${"ab".repeat(20)}` }, f.outputs[1]],
      [f.outputs[0], { ...f.outputs[1], value: "0" }],
      [f.outputs[0], { ...f.outputs[1], script: recipient }],
    ])
      await expect(f.validate(transaction(f.inputs, outputs))).to.be.reverted
    for (const requests of [
      [],
      [{ ...f.requests[0], id: ethers.constants.HashZero }],
      [{ ...f.requests[0], value: "10001" }],
      [{ ...f.requests[0], script: changeScript }],
    ])
      await expect(f.validate(f.tx, f.inputs, requests)).to.be.reverted
    await expect(
      f.validate(
        f.tx,
        f.inputs,
        f.requests,
        "0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
      )
    ).to.be.revertedWith("FROST output script")
  })

  it("rejects invalid x-only keys without reducing coordinates", async () => {
    const f = await fixture()
    for (const q of [
      ethers.constants.HashZero,
      `0x${"ff".repeat(32)}`,
      "0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f",
    ])
      await expect(
        f.validate(f.tx, f.inputs, f.requests, q)
      ).to.be.revertedWith("FROST output key")
  })

  it("rejects zero/negative fees and monetary-cap sums without narrowing", async () => {
    const f = await fixture()
    for (const change of ["90000", "90001", "2100000000000001"])
      await expect(
        f.validate(
          transaction(f.inputs, [
            f.outputs[0],
            { value: change, script: changeScript },
          ])
        )
      ).to.be.reverted
    const inputs = [
      { ...f.inputs[0], txOutputValue: "2100000000000000" },
      {
        txHash: ethers.utils.id("other cap"),
        txOutputIndex: 0,
        txOutputValue: "1",
      },
    ]
    await expect(
      f.validate(transaction(inputs, f.outputs), inputs)
    ).to.be.revertedWith("FROST input value sum")
    const cap = [inputs[0]]
    const requests = [{ ...f.requests[0], value: "2100000000000000" }]
    await expect(
      f.validate(
        transaction(cap, [...requests, { value: "1", script: changeScript }]),
        cap,
        requests
      )
    ).to.be.revertedWith("FROST output value sum")
  })

  it("derives cancellation snapshot/txid/vsize from one exact-Q output and retained conflict input", async () => {
    const f = await fixture()
    const tx = transaction(f.inputs, [{ value: "99000", script: changeScript }])
    const result = await f.validator.validateCancellation(tx, key, f.inputs)
    expect(result.changeIndex).to.equal(0)
    expect(result.changeValue.toString()).to.equal("99000")
    expect(result.fee.toString()).to.equal("1000")
    expect(result.snapshot).to.equal(independentSnapshot(tx, f.inputs))
    expect(result.txHash).to.equal(
      ethers.utils.sha256(ethers.utils.sha256(raw(tx)))
    )
    expect(result.virtualSize.toNumber()).to.equal(independentVsize(tx, 1))
    await expect(
      f.validator.validateCancellation(f.tx, key, f.inputs)
    ).to.be.revertedWith("FROST output count")
    await expect(
      f.validator.validateCancellation(
        transaction(f.inputs, [{ value: "99000", script: recipient }]),
        key,
        f.inputs
      )
    ).to.be.revertedWith("FROST output script")
    await expect(
      f.validator.validateCancellation(
        transaction(
          [{ ...f.inputs[0], txOutputIndex: 1 }],
          [{ value: "99000", script: changeScript }]
        ),
        key,
        f.inputs
      )
    ).to.be.revertedWith("FROST input outpoint")
  })

  it("checks derived fee min/max/rate at full width and rejects fractional excess", async () => {
    const f = await fixture()
    const result = await f.validate()
    const ceiling = result.fee
      .add(result.virtualSize)
      .sub(1)
      .div(result.virtualSize)
    await expect(f.validator.validateFees(result, 100, 2000, ceiling)).not.to.be
      .reverted
    for (const policy of [
      [0, 2000, ceiling],
      [1001, 2000, ceiling],
      [100, 999, ceiling],
      [2001, 2000, ceiling],
      [100, ethers.constants.MaxUint256, ceiling],
      [100, 2000, 0],
      [100, 2000, ethers.constants.MaxUint256],
    ])
      await expect(
        f.validator.validateFees(result, ...policy)
      ).to.be.revertedWith("FROST transaction fee")
    await expect(
      f.validator.validateFees(
        result,
        100,
        2000,
        result.fee.div(result.virtualSize)
      )
    ).to.be.revertedWith("FROST transaction fee rate")
    const exact = {
      snapshot: result.snapshot,
      txHash: result.txHash,
      fee: "1000",
      changeValue: result.changeValue,
      changeIndex: result.changeIndex,
      virtualSize: "100",
    }
    await expect(f.validator.validateFees(exact, 1000, 1000, 10)).not.to.be
      .reverted
  })

  it("handles the joint input/request profile and rejects larger counts with independently serialized vsize", async () => {
    const f = await fixture()
    for (const n of [2, 31, 32]) {
      const inputs = Array.from({ length: n }, (_, i) => ({
        txHash: ethers.utils.id(`max-input-${i}`),
        txOutputIndex: i,
        txOutputValue: "1000",
      }))
      const count = n === 32 ? 64 : 1
      const requests: Payee[] = Array.from({ length: count }, (_, i) => ({
        id: ethers.utils.id(`max-payee-${i}`),
        value: "1",
        script: recipient,
      }))
      const tx = transaction(inputs, [
        ...requests,
        { value: String(n * 1000 - count - 1000), script: changeScript },
      ])
      const result = await f.validate(tx, inputs, requests)
      expect(result.snapshot).to.equal(independentSnapshot(tx, inputs))
      expect(result.virtualSize.toNumber()).to.equal(independentVsize(tx, n))
      expect(result.changeIndex).to.equal(count)
      if (n === 32)
        console.log(
          `32-input/65-output parser gas: ${(
            await f.validator.estimateGas.validateRedemption(
              tx,
              key,
              inputs,
              requests
            )
          ).toString()}`
        )
    }
    const tooMany = Array.from({ length: 33 }, (_, i) => ({
      txHash: ethers.utils.id(`too-many-${i}`),
      txOutputIndex: 0,
      txOutputValue: "1000",
    }))
    await expect(
      f.validate(transaction(tooMany, f.outputs), tooMany)
    ).to.be.revertedWith("FROST input count")
  })

  it("includes sequence/locktime/outpoint and recognized value changes in the snapshot", async () => {
    const f = await fixture()
    const original = await f.validate()
    for (const tx of [
      transaction(f.inputs, f.outputs, 0xfffffffe),
      transaction(f.inputs, f.outputs, 0xfffffffd, 1),
    ]) {
      const r = await f.validate(tx)
      expect(r.snapshot).not.to.equal(original.snapshot)
      expect(r.snapshot).to.equal(independentSnapshot(tx, f.inputs))
      expect(r.txHash).not.to.equal(original.txHash)
    }
  })
})
