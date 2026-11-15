// The page module of a view that starts one timeout and one animation frame when it loads. done resolves when the timeout runs.
export const done = new Promise((resolve) => {
  setTimeout(resolve, 0);
  requestAnimationFrame(() => {});
});
