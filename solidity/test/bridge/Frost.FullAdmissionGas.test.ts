/* eslint-disable no-await-in-loop, no-restricted-syntax */
// GAS ONLY: controlled roots/Bank issuance, not public custody or producer qualification.
import { ethers } from "hardhat"
import { expect } from "chai"
import { reservationProposal } from "../helpers/frost-reservation-proposal"

describe("FROST complete admission joint gas component", () => {
  it("measures complete parsing/certificate/archival costs at combined shapes", async () => {
    const [owner] = await ethers.getSigners()
    const rows = []
    let collisionNonce = 0
    for (const [requestCount, inputCount] of [[64, 32]]) {
      const cache = new Map<string, string>()
      const { artifacts } = await import("hardhat")
      const deploy = async (name: string): Promise<any> => {
        const a = await artifacts.readArtifact(name)
        expect((a.deployedBytecode.length - 2) / 2).at.most(24576)
        let { bytecode } = a
        for (const [source, libraries] of Object.entries(a.linkReferences))
          for (const [library, positions] of Object.entries(libraries)) {
            const key = `${source}:${library}`
            if (!cache.has(key)) cache.set(key, (await deploy(key)).address)
            for (const p of positions)
              bytecode =
                bytecode.slice(0, 2 + p.start * 2) +
                cache.get(key)!.slice(2) +
                bytecode.slice(2 + (p.start + p.length) * 2)
          }
        const c = await new ethers.ContractFactory(
          a.abi,
          bytecode,
          owner
        ).deploy()
        await c.deployed()
        return c
      }
      const f = await deploy("FrostFullAdmissionGasFixture")
      const bank = await ethers.getContractAt("Bank", await f.bank())
      const genesis = ethers.utils.id("synthetic-gas-genesis")
      const outputKey =
        "0xf9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9"
      const descriptor = {
        scheme: 2,
        profile: 1,
        chainId: (await ethers.provider.getNetwork()).chainId,
        registry: owner.address,
        epoch: 1,
        members: Array.from({ length: 100 }, (_, i) => i + 1),
        operators: Array(100).fill(owner.address),
        threshold: 100,
        snowfallDescriptor: ethers.utils.id("synthetic-gas-dkg"),
        outputKey,
      }
      const descriptorHash = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          [
            "bytes32",
            "tuple(uint8 scheme,uint8 profile,uint256 chainId,address registry,uint64 epoch,uint32[] members,address[] operators,uint16 threshold,bytes32 snowfallDescriptor,bytes32 outputKey)",
          ],
          [ethers.utils.id("tbtc-v2/frost-descriptor/v1"), descriptor]
        )
      )
      const walletId = ethers.utils.keccak256(
        ethers.utils.concat([
          ethers.utils.id("tbtc-v2/frost-wallet-id/v1"),
          outputKey,
        ])
      )
      await f.configureForGas(descriptor, genesis)
      const inputs = []
      for (let i = 0; i < inputCount; i++) {
        let candidate = ""
        for (;;) {
          candidate = ethers.utils.id(`gas-collision-${collisionNonce}`)
          collisionNonce += 1
          if (
            ethers.BigNumber.from(
              ethers.utils.solidityKeccak256(
                ["bytes32", "uint32"],
                [candidate, 0]
              )
            )
              .and(63)
              .eq(63)
          )
            break
        }
        const input = {
          txHash: candidate,
          txOutputIndex: 0,
          txOutputValue: 1000000,
        }
        inputs.push(input)
        await f.creditForComponent(
          walletId,
          0,
          input.txHash,
          0,
          input.txOutputValue
        )
      }
      await f.issueForComponent(owner.address, requestCount * 3000)
      await bank.approveBalance(f.address, requestCount * 3000)
      const admission = {
        walletId,
        descriptorHash,
        balanceOwner: owner.address,
        redeemer: owner.address,
        gross: 3000,
        treasuryFee: 30,
        maximumBitcoinFee: 2000,
        timeoutSeconds: 86400,
        finalityBlocks: 2,
        script: `0x0020${"11".repeat(32)}`,
      }
      const requests = []
      for (let i = 0; i < requestCount; i++) {
        const id = await f.callStatic.request(admission)
        await f.request(admission)
        requests.push({ id, value: 2900, script: admission.script })
      }
      const wallet = await f.wallet(walletId)
      const proposal = await reservationProposal({
        bridge: f.address,
        chainId: descriptor.chainId,
        walletId,
        descriptorHash,
        genesis,
        outputKey,
        generation: wallet.generation.add(1),
        stateVersion: wallet.stateVersion,
        validUntilBlock: (await ethers.provider.getBlockNumber()) + 100,
        inputs,
        requests,
        fee: requestCount * 70,
        maximumFee: 200000,
        operators: [owner, owner],
      })
      const seats = Array.from({ length: 100 }, (_, i) => i + 1)
      proposal.seats = seats
      proposal.signatures = ethers.utils.hexConcat(
        Array(100).fill(ethers.utils.hexDataSlice(proposal.signatures, 0, 65))
      )
      const gas = await f.estimateGas.fullAdmissionForGas(proposal)
      const receipt = await (
        await f.fullAdmissionForGas(proposal, { gasLimit: 16777216 })
      ).wait()
      expect(receipt.gasUsed.lt(16777216)).eq(true)
      rows.push({
        requestCount,
        inputCount,
        seats: 100,
        completeLibraryAdmissionGas: gas.toString(),
        actualTransactionGas: receipt.gasUsed.toString(),
        collidingInputs: true,
        belowTransactionCap: gas.lt(16777216),
      })
      expect(gas.gt(0)).eq(true)
    }
    console.log(
      JSON.stringify({ gasOnly: true, BridgeFallbackExcluded: true, rows })
    )
  })
})
