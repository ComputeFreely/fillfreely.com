# Fill Freely

Fill Freely is a free browser PDF form filler and visual PDF signer.

Live site: https://fillfreely.com/

Use Fill Freely for PDF forms, text marks, checkmarks, dates, initials, and signature appearances. Use PDF Freely when you need to merge, split, rotate, reorder, or watermark PDF pages.

## Features

- Load a PDF locally in the browser with no upload step.
- Detect and edit common PDF form fields.
- Add freeform text, checkmarks, dates, initials, and visual signatures.
- Move, edit, resize, and delete placed marks.
- Preserve editable form fields by default, with optional flattening on export.
- Download the filled PDF locally.

## Run Locally

This is a static site. It can be opened directly from disk:

```text
file:///path/to/fillfreely.com/index.html
```

Or served from this directory:

```sh
python3 -m http.server 4177
```

Then open `http://localhost:4177`.

## Limits

- Visual signatures are image marks, not cryptographic digital signatures.
- Redaction is intentionally not included because fake redaction can leave underlying PDF content extractable.
- Encrypted PDFs that require a password are not supported yet.
- Large PDFs are limited by browser memory.
- Unusual PDF form fields may need to be filled with freeform marks instead.

## Vendor Libraries

- `pdf-lib` 1.17.1, MIT license, https://pdf-lib.js.org/
- PDF.js 3.11.174, Apache-2.0 license, https://mozilla.github.io/pdf.js/

## License

CC0-1.0. See `LICENSE`.
