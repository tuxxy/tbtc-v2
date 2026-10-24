// Bounded config-only control: no provider, account, RPC or transaction is used.
const assert = require("assert")
const fs = require("fs")
const ts = require("typescript")
const vm = require("vm")
const source = fs.readFileSync("hardhat.k09.config.ts", "utf8")
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText
function load(network) {
  const callbacks = []
  // The imported config represents settings AFTER dotenv/plugin loading.
  const imported = {
    defaultNetwork: "mainnet",
    networks: {
      hardhat: { forking: { enabled: true, url: "https://invalid.example" } },
      mainnet: { url: "https://invalid.example" },
    },
  }
  const sandbox = {
    exports: {},
    process: {
      env: { HARDHAT_NETWORK: network, FORKING_URL: "https://invalid.example" },
    },
    require(name) {
      if (name === "hardhat/config")
        return { extendEnvironment: (fn) => callbacks.push(fn) }
      assert.strictEqual(name, "./hardhat.config")
      return { default: imported }
    },
  }
  vm.runInNewContext(compiled, sandbox, { timeout: 1000 })
  return { config: sandbox.exports.default, callbacks }
}
assert.throws(() => load("mainnet"), /local hardhat network/)
const { config, callbacks } = load("hardhat")
assert.strictEqual(config.defaultNetwork, "hardhat")
assert.deepStrictEqual(Object.keys(config.networks), ["hardhat"])
assert.strictEqual(config.networks.hardhat.forking, undefined)
assert.strictEqual(config.networks.hardhat.allowUnlimitedContractSize, false)
for (const check of callbacks) {
  check({ network: { name: "hardhat", config: config.networks.hardhat } })
  assert.throws(
    () => check({ network: { name: "mainnet", config: {} } }),
    /local, unforked/
  )
  assert.throws(
    () =>
      check({
        network: { name: "hardhat", config: { forking: { enabled: true } } },
      }),
    /local, unforked/
  )
}
assert.strictEqual(callbacks.length, 1)
console.log(
  "K-09 config control: external selection and inherited forks refused; local positive witness passes"
)
