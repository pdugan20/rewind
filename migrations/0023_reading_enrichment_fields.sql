-- Add enrichment fields to reading_items
ALTER TABLE reading_items ADD COLUMN published_at TEXT;
ALTER TABLE reading_items ADD COLUMN og_image_url TEXT;
ALTER TABLE reading_items ADD COLUMN og_description TEXT;
ALTER TABLE reading_items ADD COLUMN article_tags TEXT;
ALTER TABLE reading_items ADD COLUMN enrichment_status TEXT DEFAULT 'pending';
ALTER TABLE reading_items ADD COLUMN enrichment_error TEXT;
