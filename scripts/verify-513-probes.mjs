// In-page probe expressions for the #513 live check (evaluated over CDP).

export const GROUP_SEL = '[role="group"][aria-label="Attached images"]';

/** Facts about the Nth (0-based) user bubble in the transcript. */
export function probeBubble(index) {
  return `
    (() => {
      const transcript = document.querySelector('[aria-label="Transcript"]');
      const bubble = transcript.querySelectorAll('[data-slot="message"][data-align="end"]')[${index}];
      if (!bubble) return { error: 'no bubble ${index}' };
      const group = bubble.querySelector('${GROUP_SEL}');
      if (!group) return { error: 'no image group in bubble ${index}', text: bubble.innerText };
      const tiles = Array.from(group.querySelectorAll('button'));
      const imgs = Array.from(group.querySelectorAll('img'));
      const img = imgs[0];
      const grid = group.firstElementChild;
      const cols = grid && getComputedStyle(grid).display === 'grid' ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0;
      const overlays = Array.from(group.querySelectorAll('button span')).map((el) => ({ text: el.textContent.trim(), tileIndex: tiles.indexOf(el.closest('button')) })).filter((o) => /^\\+\\d+$/.test(o.text));
      const contentEl = bubble.querySelector('[data-slot="message-content"]') || bubble;
      const textNodes = Array.from(contentEl.querySelectorAll('p, div, span')).filter((el) => !group.contains(el) && !el.closest('[data-slot="message-header"]') && !el.querySelector('p, div, span, img, button') && el.textContent.trim() !== '');
      const emptyBlocks = Array.from(contentEl.querySelectorAll('p')).filter((el) => !group.contains(el) && el.textContent.trim() === '');
      const text = textNodes.map((el) => el.textContent.trim()).join(' | ');
      const groupRect = group.getBoundingClientRect();
      return {
        tiles: tiles.length,
        imgs: imgs.length,
        imgSrcData: imgs.length > 0 && imgs.every((i) => i.src.startsWith('data:')),
        imgW: img ? Math.round(img.getBoundingClientRect().width * 10) / 10 : 0,
        imgH: img ? Math.round(img.getBoundingClientRect().height * 10) / 10 : 0,
        natW: img ? img.naturalWidth : 0,
        natH: img ? img.naturalHeight : 0,
        columns: cols,
        groupWidth: groupRect.width,
        overlays,
        placeholders: group.querySelectorAll('[role="img"][aria-label="Image no longer available"]').length,
        hasText: text !== '',
        text,
        emptyTextBlock: emptyBlocks.length > 0,
        bubbleText: bubble.innerText,
        transcriptHasImageAttached: transcript.textContent.includes('Image attached'),
      };
    })()
  `;
}

/** The open viewer dialog's title, current image and natural size. */
export function viewerProbe() {
  return `
    (() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return { error: 'no dialog' };
      const title = dialog.querySelector('h2, [data-slot="dialog-title"]');
      const img = dialog.querySelector('img[alt="Attached image, full size"]');
      return {
        title: title ? title.textContent.trim() : null,
        src: img ? img.src : null,
        srcData: !!img && img.src.startsWith('data:'),
        natW: img ? img.naturalWidth : 0,
        natH: img ? img.naturalHeight : 0,
      };
    })()
  `;
}
