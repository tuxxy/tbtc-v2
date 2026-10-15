/* eslint-disable no-await-in-loop, no-restricted-syntax */
import { ethers } from "hardhat"
import { Contract } from "ethers"
import { expect } from "chai"
import { execFileSync } from "child_process"
import fs from "fs"
import os from "os"
import path from "path"

const helper = path.join(__dirname, "../helpers/frost-verifier-oracle")
interface Verification {
  ID: string
  Key: string
  Message: string
  Signature: string
  Valid: boolean
}
interface Tweak {
  ID: string
  Key: string
  Root: string
  Valid: boolean
  OutputKey: string
  Parity: number
}
interface Oracle {
  Seed: string
  Modules: Record<string, string>
  Verify: Verification[]
  Tweak: Tweak[]
}

describe("C-07 pinned keep-core Bitcoin Go differential oracle", function bitcoinOracleTests() {
  this.timeout(180000)
  let oracle: Oracle
  let verifier: Contract
  before(async () => {
    oracle = JSON.parse(
      execFileSync("go", ["run", "-mod=readonly", "."], {
        cwd: helper,
        timeout: 180000,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          GOPROXY: "off",
          GOSUMDB: "off",
          GOTOOLCHAIN: "local",
          GOWORK: "off",
          GOFLAGS: "",
          GOMAXPROCS: "2",
          GOCACHE:
            process.env.GOCACHE ||
            path.join(os.tmpdir(), "c07-oracle-go-cache"),
        },
      }).toString()
    )
    verifier = await (await ethers.getContractFactory("FrostVerifier")).deploy()
    await verifier.deployed()
  })
  it("uses the exact keep-core K-04 crypto dependency pins and a fixed seed", () => {
    const pins = JSON.parse(
      fs.readFileSync(path.join(helper, "provenance.json"), "utf8")
    )
    expect(pins.keepCoreRevision).to.equal(
      "f75b7bc2a56e6b700750e31ce647a7ef90156fc9"
    )
    for (const [module, version] of Object.entries(pins.modules)) {
      expect(oracle.Modules[module], module).to.equal(version)
    }
    expect(oracle.Seed).to.equal("C07-keep-core-btcd-differential-v1")
    expect(oracle.Verify.length).to.equal(150)
    expect(oracle.Verify.filter((v) => v.Valid).length).to.equal(40)
    expect(oracle.Tweak.length).to.equal(23)
  })
  it("matches Schnorr Verify on seeded signatures, mutations and encoding boundaries", async () => {
    for (const v of oracle.Verify) {
      expect(
        await verifier.verify(v.Key, v.Message, v.Signature, {
          gasLimit: 8000000,
        }),
        v.ID
      ).to.equal(v.Valid)
    }
  })
  it("matches ComputeTaprootOutputKey on explicit roots and boundary public keys", async () => {
    for (const v of oracle.Tweak.filter((v) => v.Root !== "0x")) {
      const actual = await verifier.tapTweak(v.Key, v.Root, {
        gasLimit: 8000000,
      })
      expect(actual.valid, v.ID).to.equal(v.Valid)
      if (v.Valid) {
        expect(actual.outputKey, v.ID).to.equal(v.OutputKey)
        expect(actual.parity, v.ID).to.equal(v.Parity)
      }
    }
  })
  it("does not interpret bytes32 zero as the empty-root BIP86 tweak", async () => {
    const explicit = oracle.Tweak.find((v) => v.ID === "seed-0/zero-root")
    const bip86 = oracle.Tweak.find((v) => v.ID === "BIP86-empty-root")
    if (!explicit || !bip86) throw new Error("Missing root-domain controls")
    expect(explicit.Valid).to.equal(true)
    expect(bip86.Valid).to.equal(true)
    expect(explicit.Key).to.equal(bip86.Key)
    expect(explicit.OutputKey).not.to.equal(bip86.OutputKey)
    const actual = await verifier.tapTweak(explicit.Key, explicit.Root, {
      gasLimit: 8000000,
    })
    expect(actual.valid).to.equal(true)
    expect(actual.outputKey).to.equal(explicit.OutputKey)
    expect(actual.outputKey).not.to.equal(bip86.OutputKey)
  })
})
