import { renderTreeHelper, setupApiBlock, setupBlock, wrapImportLine } from "../harness/index.js";
import { FUNCTION_MARKER } from "../props/index.js";

export interface ProbeEntryOptions {
  componentRelative: string;
  componentName: string;
  isDefaultExport: boolean;
  wrapRelative?: string;
}

// Kept as source so one definition serves the browser and the unit tests.
export const CALLBACK_PROPS_SOURCE = `function __120fpsCallbackProps(props, cache, marker, measured, fresh) {
  var out = {};
  var keys = Object.keys(props || {});
  for (var i = 0; i < keys.length; i++) out[keys[i]] = props[keys[i]];
  var stableFor = function (name) {
    if (!cache.has(name)) cache.set(name, function __120fpsStableCallback() {});
    return cache.get(name);
  };
  for (var j = 0; j < keys.length; j++) {
    if (out[keys[j]] === marker) out[keys[j]] = stableFor(keys[j]);
  }
  if (measured) {
    out[measured] = fresh ? function __120fpsFreshCallback() {} : stableFor(measured);
  }
  return out;
}`;

export function generateProbeEntry(opts: ProbeEntryOptions): string {
  const importLine = opts.isDefaultExport
    ? `import ${opts.componentName} from "/${opts.componentRelative}";`
    : `import { ${opts.componentName} as Component } from "/${opts.componentRelative}";`;

  const componentRef = opts.isDefaultExport ? opts.componentName : "Component";

  return `
import { createElement, createContext, memo, useState, useCallback, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
${wrapImportLine(opts.wrapRelative)}${importLine}

const __120fpsContext = createContext(0);
__120fpsContext.displayName = "__120fpsProbeContext";

// The memo boundary keeps the provider's own re-render from cascading, so a
// value change reaches only fibers that actually read the context.
const __120fpsStable = memo(function __120fpsStable({ node }: { node: ReactNode }) {
  return node;
});

function __120fpsContextProbe({ children }: { children: ReactNode }) {
  const [value, setValue] = useState(0);
  (window as any).__120fps_forceContext = () => setValue((v: number) => v + 1);
  return createElement(
    __120fpsContext.Provider,
    { value },
    createElement(__120fpsStable, { node: children }),
  );
}

const container = document.getElementById("root")!;
let root = createRoot(container);
let mounted = false;
const stableCallbackCache = new Map<string, Function>();
${CALLBACK_PROPS_SOURCE}
${renderTreeHelper(opts.wrapRelative)}
${setupBlock(opts.wrapRelative)}
(window as any).__120fps = {
  mount(props: any = {}) {
    if (mounted) {
      root.unmount();
      root = createRoot(container);
    }
    renderTree(
      createElement(__120fpsContextProbe, null,
        createElement(${componentRef}, props)
      )
    );
    mounted = true;
  },
  mountWrapperOnly() {
    if (mounted) {
      root.unmount();
      root = createRoot(container);
    }
    renderTree(null);
    mounted = true;
  },
  unmount() {
    if (mounted) {
      root.unmount();
      root = createRoot(container);
      mounted = false;
    }
  },
  rerender(props: any = {}) {
    renderTree(
      createElement(__120fpsContextProbe, null,
        createElement(${componentRef}, props)
      )
    );
  },
  forceContextUpdate() {
    (window as any).__120fps_forceContext?.();
  },
  // The mount installs the same cached callback the stable arm re-renders with:
  // mounting with a fresh function makes both arms change callback identity, and
  // the measured difference is then drift rather than identity.
  mountWithStableCallbacks(props: any, measured: string) {
    this.mount(__120fpsCallbackProps(props, stableCallbackCache, "${FUNCTION_MARKER}", measured, false));
  },
  rerenderWithStableCallbacks(props: any, measured: string) {
    this.rerender(__120fpsCallbackProps(props, stableCallbackCache, "${FUNCTION_MARKER}", measured, false));
  },
  rerenderWithFreshCallbacks(props: any, measured: string) {
    this.rerender(__120fpsCallbackProps(props, stableCallbackCache, "${FUNCTION_MARKER}", measured, true));
  },
  getContainer() {
    return container;
  },
};
${setupApiBlock(opts.wrapRelative)}${probeViewportBlock(opts.wrapRelative)}
`;
}

function probeViewportBlock(wrapRelative?: string): string {
  if (!wrapRelative) return "";
  return `
const __120fpsViewport = (__120fpsWrapModule as any).viewport;
if (__120fpsViewport) (window as any).__120fps.viewport = __120fpsViewport;
`;
}

export function generateProbeHtml(): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>120fps probe</title></head>
<body><div id="root"></div><script type="module" src="./probe-entry.tsx"></script></body>
</html>`;
}
