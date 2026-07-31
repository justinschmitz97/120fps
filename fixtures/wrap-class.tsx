import React, { Component, type ReactNode } from "react";

export default class WrapClass extends Component<{ children: ReactNode }> {
  render() {
    return <div className="wrap-class">{this.props.children}</div>;
  }
}
