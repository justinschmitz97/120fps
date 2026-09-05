import { type CompositionNode, type CompositionTree, type ExportInfo } from "../props/index.js";
import { type Renderer } from "./renderer.js";
import { cssImportBlock } from "./style-tooling.js";

function collectComponents(node: CompositionNode, set: Set<string>): void {
  if (node.component !== "__text__") set.add(node.component);
  for (const child of node.children) collectComponents(child, set);
}

function nodeToJsx(node: CompositionNode): string {
  if (node.component === "__text__") {
    return JSON.stringify(node.props.text ?? "");
  }

  const propsEntries = Object.entries(node.props);
  const propsStr = propsEntries
    .map(([k, v]) => {
      if (typeof v === "boolean") return v ? k : `${k}={false}`;
      if (typeof v === "string") return `${k}=${JSON.stringify(v)}`;
      return `${k}={${JSON.stringify(v)}}`;
    })
    .join(" ");

  const opening = propsStr ? `<${node.component} ${propsStr}>` : `<${node.component}>`;

  if (node.children.length === 0) {
    return propsStr ? `<${node.component} ${propsStr} />` : `<${node.component} />`;
  }

  const childrenJsx = node.children.map(nodeToJsx).join("\n");
  return `${opening}\n${childrenJsx}\n</${node.component}>`;
}

export function compositionToJsx(tree: CompositionTree): string {
  if (tree.structure.length === 0) return "";
  return nodeToJsx(tree.structure[0]);
}

// A namespace import always links; a type re-exported as a value would fail the whole module.
export function componentModuleImport(componentRelative: string): string {
  return `import * as __120fps_mod from "/${componentRelative}";`;
}

export function EXPORT_NOT_RUNTIME_VALUE(name: string): string {
  return `export ${name} is not a runtime value (a type-only export?)`;
}

// selectExport throws at module evaluation, so the page error names the missing export.
export function componentExportSelector(): string {
  return `const __120fps_selectExport = (name: string): any => {
  const value = name === "default" ? (__120fps_mod as any).default : (__120fps_mod as any)[name];
  if (value === undefined) {
    throw new Error(
      "export " + name + " is not a runtime value (a type-only export?); runtime exports: " +
        (Object.keys(__120fps_mod).join(", ") || "none"),
    );
  }
  return value;
};`;
}

// `scale` is optional by contract, so it is read, never selected: an absent one is undefined.
export function scaleBinding(hasScale?: boolean): string {
  return hasScale ? `
const __120fps_scale = (__120fps_mod as any).scale;` : "";
}

// Namespace alongside the default: a missing `viewport` export must not fail the link.
export function wrapImportLine(wrapRelative?: string): string {
  return wrapRelative
    ? `import __120fpsWrap, * as __120fpsWrapModule from "/${wrapRelative}";\n`
    : "";
}

// Opt-in: only the measurement templates declare the strict bindings.
export function renderTreeHelper(wrapRelative?: string, strict?: boolean): string {
  const el = strict ? "__120fpsInStrict(el)" : "el";
  return wrapRelative
    ? `const renderTree = (el: any) => root.render(__120fpsWrap ? createElement(__120fpsWrap, null, ${el}) : ${el});`
    : `const renderTree = (el: any) => root.render(${el});`;
}

// StrictMode nests inside the wrapper, so the double-invoke cost measured is the component's.
export function strictBlock(): string {
  return `const __120fpsStrict = new URLSearchParams(location.search).get("strict") === "1";
const __120fpsInStrict = (el: any) => __120fpsStrict ? createElement(StrictMode, null, el) : el;`;
}

// Functions and JSX cannot cross the CDP boundary, so a preset value travels as its position.
export function presetImportLine(presetRelative?: string): string {
  return presetRelative
    ? `import __120fpsPresets from "/${presetRelative}";\n`
    : "";
}

export function presetResolverBlock(presetRelative?: string): string {
  if (!presetRelative) return "";
  return `
const __120fpsResolveProps = (props: any) => {
  const out: any = { ...props };
  for (const key of Object.keys(out)) {
    const value = out[key];
    if (value && typeof value === "object" && "__120fps_preset" in value) {
      const pool = (__120fpsPresets as any)[value.__120fps_preset];
      out[key] = Array.isArray(pool) ? pool[value.index] : pool;
    }
  }
  return out;
};
`;
}

// Substituted once per entry point, so scale fan-outs and composed scenes need no extra case.
export function presetResolveStatement(presetRelative?: string): string {
  return presetRelative ? "props = __120fpsResolveProps(props);" : "";
}

// Bounded: an unbounded setup would surface as a bare readiness timeout naming the harness.
export const WRAPPER_SETUP_TIMEOUT_MS = 15000;

// Top-level await ahead of the control API: readiness implies setup finished.
export function setupBlock(wrapRelative?: string): string {
  if (!wrapRelative) return "";
  return `
const __120fpsSetup = (__120fpsWrapModule as any).setup;
if (typeof __120fpsSetup === "function") {
  await Promise.race([
    Promise.resolve(__120fpsSetup()),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("120fps: wrapper setup did not finish within ${WRAPPER_SETUP_TIMEOUT_MS}ms")),
        ${WRAPPER_SETUP_TIMEOUT_MS},
      ),
    ),
  ]);
}
`;
}

// Session-scoped: later samples depend on what setup installed, so teardown is not per-unmount.
export function setupApiBlock(wrapRelative?: string): string {
  if (!wrapRelative) return "";
  return `
(window as any).__120fps.hasSetup = typeof __120fpsSetup === "function";
(window as any).__120fps.teardown = async () => {
  const __120fpsTeardown = (__120fpsWrapModule as any).teardown;
  if (typeof __120fpsTeardown === "function") await __120fpsTeardown();
};
`;
}

// Rules nested under an ancestor the harness never renders would read as a styled measurement.
export const STYLESHEET_MATCH_STATS_SOURCE = `function __120fpsStylesheetMatchStats(specifiers, doc, root) {
  var countRules = function (list, stats) {
    for (var i = 0; i < list.length; i++) {
      var rule = list[i];
      if (rule.selectorText) {
        stats.rules++;
        // Review I7: a rule is matched when ANY of its comma-separated parts
        // matches. A part scoped to the document itself (:root, html, body, *)
        // can never be found under #root by querySelector, yet a design-token
        // sheet made of :root custom properties is exactly the kind that does
        // apply — counting it as unmatched said "unstyled" about a stylesheet
        // the render used.
        var parts = String(rule.selectorText).split(",");
        for (var p = 0; p < parts.length; p++) {
          var part = parts[p].trim();
          if (!part) continue;
          if (/^(:root|html|body|\\*)([^a-zA-Z0-9_-]|$)/.test(part)) {
            stats.matched++;
            break;
          }
          try {
            if (root && (root.querySelector(part) || (root.matches && root.matches(part)))) {
              stats.matched++;
              break;
            }
          } catch (selectorError) {
            // A part querySelector rejects matched nothing here either.
          }
        }
      } else if (rule.cssRules) {
        countRules(Array.prototype.slice.call(rule.cssRules), stats);
      }
    }
  };
  var out = [];
  var sheets = Array.prototype.slice.call((doc && doc.styleSheets) || []);
  for (var s = 0; s < specifiers.length; s++) {
    var specifier = specifiers[s];
    var wanted = specifier.indexOf("/@fs/") === 0 ? specifier.slice(5) : specifier.replace(/^\\//, "");
    var stats = { file: wanted, rules: 0, matched: 0 };
    for (var i = 0; i < sheets.length; i++) {
      var node = sheets[i].ownerNode;
      var id = node && node.getAttribute
        ? node.getAttribute("data-vite-dev-id") || node.getAttribute("href") || ""
        : "";
      id = String(id).replace(/\\\\/g, "/").split("?")[0];
      if (!wanted || id.slice(-wanted.length) !== wanted) continue;
      var rules;
      try {
        rules = sheets[i].cssRules;
      } catch (readError) {
        continue;
      }
      countRules(Array.prototype.slice.call(rules || []), stats);
    }
    out.push(stats);
  }
  return out;
}`;

export function stylesheetMatchStatsBlock(cssImports?: string[]): string {
  if (!cssImports || cssImports.length === 0) return "";
  return `
${STYLESHEET_MATCH_STATS_SOURCE}
(window as any).__120fps.stylesheetMatchStats = () =>
  __120fpsStylesheetMatchStats(${JSON.stringify(cssImports)}, document, document.getElementById("root"));
`;
}

function viewportBlock(wrapRelative?: string): string {
  if (!wrapRelative) return "";
  return `
const __120fpsViewport = (__120fpsWrapModule as any).viewport;
if (__120fpsViewport) (window as any).__120fps.viewport = __120fpsViewport;
`;
}

export interface EntryOptions {
  componentRelative: string;
  componentName: string;
  isDefaultExport: boolean;
  hasScale: boolean;
  wrapRelative?: string;
  cssImports?: string[];
  presetRelative?: string;
  // Absent means React.
  renderer?: Renderer;
  // Only an unconditional root is safe to force into a stable wrapped render (vue-sfc.ts).
  vueUnconditionalRoot?: boolean;
}

// The renderer supplies the import block, the mount and unmount bodies, and `renderTree`.
export function generateEntry(opts: EntryOptions): string {
  return opts.renderer === "vue" ? generateVueEntry(opts) : generateReactEntry(opts);
}

// Vue drains updates on nextTick(), so rerender awaits it; resolving earlier times scheduling.
export function generateVueEntry(opts: EntryOptions): string {
  const {
    componentRelative,
    componentName,
    hasScale,
    wrapRelative,
    cssImports,
    presetRelative,
    vueUnconditionalRoot,
  } = opts;

  // An SFC always exports its component as the default, so the selected name is fixed.
  const importLine =
    componentModuleImport(componentRelative) +
    `
${componentExportSelector()}
const ${componentName} = __120fps_selectExport("default");` +
    scaleBinding(hasScale);

  // Auto-scale fans N instances out inside one element, wrapped once.
  const scaleBranch = hasScale
    ? `  if (typeof props.__120fps_scaleN === "number" && typeof __120fps_scale === "function") {
    return __120fps_scale(props.__120fps_scaleN);
  }`
    : `  if (typeof props.__120fps_scaleN === "number") {
    const { __120fps_scaleN: _n, ...rest } = props;
    return h("div", null, Array.from({ length: props.__120fps_scaleN }, (_, i) =>
      h(${componentName}, { ...rest, key: i })));
  }`;

  // $slots.default is undefined with no third h() argument, and a component may call it.
  const defaultSlotsArg = `, { default: () => [] }`;
  // A conditional root is left bare so a legitimately empty render can still report zero DOM.
  const bareRender = `h(${componentName}, { ...props }${defaultSlotsArg})`;
  const rootRender = vueUnconditionalRoot ? `h("div", null, [${bareRender}])` : bareRender;

  return `
${cssImportBlock(cssImports)}import { createApp, h, nextTick, shallowRef } from "vue";
${wrapImportLine(wrapRelative)}${presetImportLine(presetRelative)}${importLine}

const container = document.getElementById("root")!;
// A plain object per render, out of a shallowRef: the component sees the same
// unproxied props a parent would hand it, and a new identity patches the child
// instead of remounting it.
const propsRef = shallowRef<any>({});
let app: any = null;
let mounted = false;
let wrapperOnly = false;

const renderComponent = () => {
  const props = propsRef.value;
${scaleBranch}
  return ${rootRender};
};
${vueRenderTreeHelper(wrapRelative)}
const __120fpsRoot = { render: () => renderTree(wrapperOnly ? null : renderComponent()) };

const startApp = () => {
  app = createApp(__120fpsRoot);
  app.mount(container);
  mounted = true;
};
const stopApp = () => {
  if (mounted) {
    app.unmount();
    app = null;
    mounted = false;
  }
};
${presetResolverBlock(presetRelative)}${setupBlock(wrapRelative)}
(window as any).__120fps = {
  mount(props: any = {}) {
    ${presetResolveStatement(presetRelative)}
    stopApp();
    wrapperOnly = false;
    propsRef.value = props;
    startApp();
  },
  mountWrapperOnly() {
    stopApp();
    wrapperOnly = true;
    propsRef.value = {};
    startApp();
  },
  unmount() {
    stopApp();
  },
  async rerender(props: any = {}) {
    ${presetResolveStatement(presetRelative)}
    propsRef.value = props;
    await nextTick();
  },
  getContainer() {
    return container;
  },
};
${setupApiBlock(wrapRelative)}${viewportBlock(wrapRelative)}${stylesheetMatchStatsBlock(cssImports)}
`;
}

// The default slot keeps the wrapper outside the component, as on the React path.
export function vueRenderTreeHelper(wrapRelative?: string): string {
  return wrapRelative
    ? `const renderTree = (node: any) => __120fpsWrap ? h(__120fpsWrap, null, { default: () => node }) : node;`
    : `const renderTree = (node: any) => node;`;
}

function generateReactEntry(opts: EntryOptions): string {
  const { componentRelative, componentName, isDefaultExport, hasScale, wrapRelative, cssImports, presetRelative } = opts;

  // Namespace import, runtime selection — see componentModuleImport.
  const componentRef = isDefaultExport ? componentName : "Component";
  const importLine =
    componentModuleImport(componentRelative) +
    `
${componentExportSelector()}
const ${componentRef} = __120fps_selectExport(` +
    `${JSON.stringify(isDefaultExport ? "default" : componentName)});` +
    scaleBinding(hasScale);

  const autoScaleRender = `if (typeof props.__120fps_scaleN === "number") {
      const n = props.__120fps_scaleN;
      const { __120fps_scaleN: _, ...restProps } = props;
      renderTree(createElement("div", null,
        ...Array.from({ length: n }, (_, i) => createElement(${componentRef}, { ...restProps, key: i }))
      ));
    } else {
      renderTree(createElement(${componentRef}, props));
    }`;

  const render = hasScale
    ? `if (typeof props.__120fps_scaleN === "number" && typeof __120fps_scale === "function") {
      renderTree(__120fps_scale(props.__120fps_scaleN));
    } else {
      renderTree(createElement(${componentRef}, props));
    }`
    : autoScaleRender;

  return `
${cssImportBlock(cssImports)}import { createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
${wrapImportLine(wrapRelative)}${presetImportLine(presetRelative)}${importLine}

const container = document.getElementById("root")!;
let root = createRoot(container);
let mounted = false;
${strictBlock()}
${renderTreeHelper(wrapRelative, true)}
${presetResolverBlock(presetRelative)}${setupBlock(wrapRelative)}
(window as any).__120fps = {
  mount(props: any = {}) {
    ${presetResolveStatement(presetRelative)}
    if (mounted) {
      root.unmount();
      root = createRoot(container);
    }
    ${render}
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
    ${presetResolveStatement(presetRelative)}
    ${render}
  },
  getContainer() {
    return container;
  },
};
${setupApiBlock(wrapRelative)}${viewportBlock(wrapRelative)}${stylesheetMatchStatsBlock(cssImports)}
`;
}

export function generateComposedEntry(
  componentRelative: string,
  tree: CompositionTree,
  exports?: ExportInfo[],
  wrapRelative?: string,
  cssImports?: string[],
): string {
  const components = new Set<string>();
  for (const node of tree.structure) collectComponents(node, components);

  const defaultExports = new Set(exports?.filter((e) => e.isDefault).map((e) => e.name) ?? []);
  const namedImports = [...components].filter((n) => !defaultExports.has(n)).sort();
  const defaultImport = [...components].find((n) => defaultExports.has(n));

  // One namespace import for the whole scene; every composed name is selected at runtime.
  const bindings = [
    ...(defaultImport ? [`const ${defaultImport} = __120fps_selectExport("default");`] : []),
    ...namedImports.map((name) => `const ${name} = __120fps_selectExport(${JSON.stringify(name)});`),
  ];
  const importLine = [
    componentModuleImport(componentRelative),
    componentExportSelector(),
    ...bindings,
  ].join("\n");
  const jsx = compositionToJsx(tree);

  return `
${cssImportBlock(cssImports)}import { createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
${wrapImportLine(wrapRelative)}${importLine}

const ComposedScene = () => (
${jsx}
);

const container = document.getElementById("root")!;
let root = createRoot(container);
let mounted = false;
${strictBlock()}
${renderTreeHelper(wrapRelative, true)}
${setupBlock(wrapRelative)}
(window as any).__120fps = {
  mount(props: any = {}) {
    if (mounted) {
      root.unmount();
      root = createRoot(container);
    }
    renderTree(<ComposedScene {...props} />);
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
    renderTree(<ComposedScene {...props} />);
  },
  getContainer() {
    return container;
  },
};
${setupApiBlock(wrapRelative)}${viewportBlock(wrapRelative)}${stylesheetMatchStatsBlock(cssImports)}
`;
}
