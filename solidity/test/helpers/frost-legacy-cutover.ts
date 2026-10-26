import { ethers } from "hardhat"
import { expect } from "chai"
import { deploy } from "./frost-movement-world"

// Public cutover setup for the actual baseline-upgrade witnesses. The
// membership/relay fixtures remain explicit adapters; Bridge storage is never
// injected, and the original obligation/financial frame is checked by callers.
export async function completeLegacyCutover(bridge: any): Promise<void> {
  const frost = await ethers.getContractAt("IFrostBridge", bridge.address)
  const registry = await deploy("FrostRegistryFixture", [bridge.address])
  await frost.configureFrostRegistry(registry.address)
  const [owner] = await ethers.getSigners()
  const exposure = await deploy("FrostExposureController", [
    bridge.address,
    owner.address,
  ])
  await exposure.openBudgetPeriod(
    "0xffffffffffffffff",
    "0xffffffffffffffff",
    ethers.utils.id("K09 local cutover budget")
  )
  await frost.installFrostExposureController(exposure.address)
  await frost.setFrostDrainEnabled(true)
  await frost.beginLegacyDkgDrain()
  await frost.completeFrostCutover(
    ethers.utils.id("K09 legacy obligation cutover")
  )
  expect(await frost.frostCreationMode()).eq(2)
}
