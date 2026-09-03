import { makeStyles } from "@acme/styling";

const useStyles = makeStyles({ root: { display: "block" } });

export function Widget() {
  const styles = useStyles();
  return <div className={styles.root} />;
}
