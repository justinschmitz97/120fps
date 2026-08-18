import React from "react";

interface FileTypeIconProps {
  filename: string;
}

function FileTypeIcon({ filename }: FileTypeIconProps) {
  return <span>{filename.split(".").pop()}</span>;
}

interface PanelProps {
  heading: string;
  files: string[];
  collapsed?: boolean;
}

function Panel({ heading, files, collapsed = false }: PanelProps) {
  return (
    <aside hidden={collapsed}>
      <h3>{heading}</h3>
      {files.map((file) => (
        <FileTypeIcon key={file} filename={file} />
      ))}
    </aside>
  );
}

export default Panel;
