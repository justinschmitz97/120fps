import React from "react";

export function AriaTree() {
  return (
    <div>
      <ul role="tree" aria-label="File browser">
        <li role="treeitem" aria-expanded={true}>
          src
          <ul role="group">
            <li role="treeitem">index.ts</li>
            <li role="treeitem">app.ts</li>
          </ul>
        </li>
        <li role="treeitem">README.md</li>
      </ul>
    </div>
  );
}
