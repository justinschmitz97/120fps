import { forwardRef, memo, type Ref } from "react";

// memo() and forwardRef() wrappers carry no name of their own. Reading
// displayName/name off the wrapper attributed every render here to "Anonymous".
const MemoArrowChildImpl = ({ label }: { label: string }) => <span>{label}</span>;
export const MemoArrowChild = memo(MemoArrowChildImpl);

const ForwardedBoxImpl = (
  { label }: { label: string },
  ref: Ref<HTMLDivElement>,
) => <div ref={ref}>{label}</div>;
export const ForwardedBox = forwardRef(ForwardedBoxImpl);

export function MemoArrowHost() {
  return (
    <div>
      <MemoArrowChild label="memo" />
      <ForwardedBox label="forwardRef" />
    </div>
  );
}

export default MemoArrowHost;
