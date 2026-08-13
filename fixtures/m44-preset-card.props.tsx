// Literal values travel as themselves; the function keeps only its position and
// is resolved in the page.
export default {
  title: ["Quarterly revenue", "Q"],
  rows: [
    [
      { id: "a", label: "Alpha" },
      { id: "b", label: "Bravo" },
      { id: "c", label: "Charlie" },
    ],
  ],
  onSelect: [(id: string) => console.log(id)],
  notAProp: ["ignored"],
};
