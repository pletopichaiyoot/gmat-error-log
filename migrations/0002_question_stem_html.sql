-- OPE (GMAT Official Practice Exam) renders inline math — fractions, radicals,
-- complex expressions, symbol tables — as inline raster <img> elements (base64
-- data: URIs) with no alt text. innerText drops them, gutting Quant/DS stems.
-- `question_stem` stays a clean readable TEXT field (math images become a
-- "[math]" marker) for the LLM coach / search / list previews; this column
-- holds the render-ready HTML (safe subset + inline data: images) so the review
-- modal can show the actual equations. Only the OPE Phase-3 enricher populates
-- it; all other sources leave it NULL and render the plain-text stem as before.
ALTER TABLE question_attempts ADD COLUMN IF NOT EXISTS question_stem_html text;
