import React from "react";

export function Contenteditable() {
  return (
    <div>
      <div contentEditable suppressContentEditableWarning>Edit me</div>
      <p>Not editable</p>
    </div>
  );
}
