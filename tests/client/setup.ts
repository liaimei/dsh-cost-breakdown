// Client project setup: React 18 `act` requires this flag to flush effects synchronously in tests.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { resetModelPrices, setModelPricesLoader } from '../../src/client/modelPrices'

// jsdom does not implement scrollIntoView; the plugin calls it when focusing
// a browser row. A no-op polyfill stands in for the platform (layout-free).
if (typeof Element !== 'undefined' && Element.prototype.scrollIntoView === undefined) {
  Element.prototype.scrollIntoView = () => {}
}

// The model-price store starts DORMANT in tests: its loader resolves never, so no spec ever reaches the network. Specs that need prices
// inject their own loader (resetModelPrices + setModelPricesLoader, see modelPrices.spec).
resetModelPrices()
setModelPricesLoader(() => new Promise(() => {}))

// jsdom's storage never lands on `globalThis` in this toolchain (Node 26 installs its own
// `localStorage` accessor that resolves to undefined without --localstorage-file), so the
// plugin's `globalThis.localStorage` probe and every spec that seeds a remembered balance
// would see nothing. Install the platform's own storage shape instead.
if (globalThis.localStorage === undefined) {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, String(value)) },
      removeItem: (key: string) => { store.delete(key) },
      clear: () => { store.clear() },
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() { return store.size },
    },
  })
}
