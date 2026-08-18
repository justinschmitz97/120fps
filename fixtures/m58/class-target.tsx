import React from "react";

interface NeedleProps {
  angle: number;
  color: string;
}

function Needle({ angle, color }: NeedleProps) {
  return <line data-angle={angle} data-color={color} />;
}

interface GaugeProps {
  value: number;
  max?: number;
  caption: string;
}

export class Gauge extends React.Component<GaugeProps> {
  render() {
    return (
      <figure>
        <Needle angle={this.props.value} color="red" />
        <figcaption>{this.props.caption}</figcaption>
      </figure>
    );
  }
}
