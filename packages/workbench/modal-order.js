/**
 * Applies the content and position that the modal document received in the order in which the host changed them.
 *
 * The host raises revision whenever it changes the content or position of a modal. The document receives the first content as the reply of a call
 * and later changes as events. The two arrive by different paths, so a reply can come after an
 * event that was made later. Content and positions older than what was already applied are discarded.
 *
 * render(content, card) draws the content. card is present only when the position of that content is newer than the applied
 * position, and null otherwise. place(card) changes only the position.
 */
export function modalOrder(render, place) {
  let content = 0;
  let position = 0;
  return {
    content({ revision, content: value }) {
      if (revision <= content) return;
      content = revision;
      const card = revision > position ? value.card : null;
      if (card) position = revision;
      render(value, card);
    },
    position({ revision, card }) {
      if (revision <= position) return;
      position = revision;
      place(card);
    },
  };
}
