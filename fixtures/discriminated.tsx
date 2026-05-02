import React from "react";

type NoticeProps =
  | { kind: "info"; message: string }
  | { kind: "error"; message: string; code: number }
  | { kind: "loading" };

export function Notice(props: NoticeProps) {
  switch (props.kind) {
    case "info":
      return <div className="info">{props.message}</div>;
    case "error":
      return <div className="error">{props.message} (code: {props.code})</div>;
    case "loading":
      return <div className="loading">Loading...</div>;
  }
}
