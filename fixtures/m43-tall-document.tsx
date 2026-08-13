// No scroll container at all: the document scrollport is what moves.
export function TallDocument() {
  return (
    <div data-testid="tall">
      {Array.from({ length: 80 }, (_, i) => (
        <p key={i} style={{ height: 40 }}>
          paragraph {i}
        </p>
      ))}
    </div>
  );
}

export default TallDocument;
