import React from "react";

export function InputTypes() {
  return (
    <form>
      <input type="text" placeholder="Name" />
      <input type="email" placeholder="Email" />
      <input type="password" placeholder="Password" />
      <input type="checkbox" />
      <input type="radio" name="choice" value="a" />
      <input type="radio" name="choice" value="b" />
      <input type="range" min="0" max="100" />
      <input type="number" />
      <input type="search" placeholder="Search" />
    </form>
  );
}
