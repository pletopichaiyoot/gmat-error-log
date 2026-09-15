// scripts/og/books.js
// Where each book keeps its CR and RC material. Chapter numbers and section
// suffixes were read off the actual PDFs; see the implementation plan's
// "Source facts established during design".

const path = require('path');
const DOCS = path.join(__dirname, '..', '..', 'docs');

const BOOKS = [
  {
    code: 'OG12',
    title: 'The Official Guide for GMAT Review, 12th Edition',
    pdf: path.join(DOCS, 'The official guide for gmat review, 12th edition.pdf'),
    ocrPdf: null,                       // native text layer; never re-OCR'd
    chapters: { RC: 7, CR: 8 },
    practiceSuffix: 'Sample Questions',
    keySuffix: 'Answer Key',
    explanationsSuffix: 'Answer Explanations',
  },
  {
    code: 'OG13',
    title: 'The Official Guide for GMAT Review, 13th Edition',
    pdf: path.join(DOCS, 'OG13.pdf'),
    ocrPdf: path.join(DOCS, 'ocr', 'OG13.ocr.pdf'),
    chapters: { RC: 7, CR: 8 },
    practiceSuffix: 'Practice Questions',
    keySuffix: 'Answer Key',
    explanationsSuffix: 'Answer Explanations',
  },
  {
    code: 'VR2',
    title: 'The Official Guide for GMAT Verbal Review, 2nd Edition',
    pdf: path.join(DOCS, 'The Official Guide for GMAT Verbal Review, 2nd edition.pdf'),
    ocrPdf: path.join(DOCS, 'ocr', 'VerbalReview2e.ocr.pdf'),
    chapters: { RC: 3, CR: 4 },
    practiceSuffix: 'Sample Questions',
    keySuffix: 'Answer Key',
    explanationsSuffix: 'Answer Explanations',
  },
];

function bookByCode(code) {
  return BOOKS.find(b => b.code === code);
}

module.exports = { BOOKS, bookByCode };
