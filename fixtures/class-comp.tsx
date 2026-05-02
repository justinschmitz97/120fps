import React from "react";

interface CounterProps {
  initialCount?: number;
  step?: number;
  label: string;
}

export class Counter extends React.Component<CounterProps> {
  render() {
    return (
      <div>
        <span>{this.props.label}</span>
        <button type="button">+{this.props.step ?? 1}</button>
      </div>
    );
  }
}
