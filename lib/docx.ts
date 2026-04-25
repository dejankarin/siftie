/**
 * Word-document parser using mammoth.
 *
 * mammoth strips Word's awful XML and gives us either plain text
 * (which Gemini reads cleanly) or HTML (which we keep around so a
 * future "View source" preview can render the doc without re-parsing).
 *
 * We catch and re-throw with a friendlier message because mammoth's
 * native errors are vague ("Could not find file in options").
 */
import 'server-only';
import mammoth from 'mammoth';

export interface ParsedDocx {
  /** Plain-text content. Sent to Gemini for indexing. */
  text: string;
  /** HTML content. Persisted in `meta.html` for later rendering. */
  html: string;
}

export async function parseDocx(buffer: Buffer): Promise<ParsedDocx> {
  if (!buffer || buffer.length === 0) {
    throw new Error('parseDocx received an empty buffer');
  }

  // mammoth in Node accepts `{ buffer }` directly; do not pass `{ path }`.
  try {
    const [textResult, htmlResult] = await Promise.all([
      mammoth.extractRawText({ buffer }),
      mammoth.convertToHtml({ buffer }),
    ]);
    return {
      text: textResult.value ?? '',
      html: htmlResult.value ?? '',
    };
  } catch (err) {
    throw new Error(
      `Failed to parse .docx: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }
}
