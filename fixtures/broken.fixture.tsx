import React from "react";

export default function BrokenScene() {
  throw new Error("Fixture mount failure");
  return <div>never reached</div>;
}
