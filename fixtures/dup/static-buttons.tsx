// Same stem as fixtures/static-buttons.tsx: exercises the report-name
// collision suffix, which deduping identical arguments no longer can.
export function StaticButtons() {
  return (
    <div>
      <button type="button">one</button>
      <button type="button">two</button>
    </div>
  );
}

export default StaticButtons;
