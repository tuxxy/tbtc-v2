// CONTROL (property 1): the Timelock hands the ProxyAdmin to the council,
// which then upgrades directly, skipping the Timelock delay. Expected:
// "[1 authority] the implementation changes only through Timelock ->
// ProxyAdmin ..." fails at "step <i>: a council step targets the
// ProxyAdmin" (the route check before any implementation change).
import { variant, council, proxyAdmin, HASH_ZERO } from "./wrong"

const v = variant((b, inputs) => {
  const steps = b.steps.filter(
    (s: any) =>
      !(
        s.kind === "timelock" &&
        s.actions.some(
          (a: any) => a.target.toLowerCase() === inputs.proxyAdmin.toLowerCase()
        )
      )
  )
  return {
    ...b,
    steps: [
      {
        kind: "timelock" as const,
        actions: [
          {
            target: inputs.proxyAdmin,
            value: 0,
            data: proxyAdmin.encodeFunctionData("transferOwnership", [
              inputs.council,
            ]),
          },
        ],
        predecessor: HASH_ZERO,
        salt: HASH_ZERO,
        description: "WRONG: ProxyAdmin to the council",
      },
      council(
        inputs.proxyAdmin,
        proxyAdmin.encodeFunctionData("upgrade", [
          inputs.bridge,
          b.bridgeImplementation,
        ]),
        "WRONG: direct upgrade by the council"
      ),
      ...steps,
    ],
  }
})
export default v.default
export const { deployFrostBridgeUpgrade } = v
