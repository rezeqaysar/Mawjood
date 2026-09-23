-- 0009: photo attached to a note
-- Chat home: the user photographs something, then talks/writes about it
-- ("اصور مفك واحكي شريت هاض المفك"). Photos are kept (retention policy:
-- audio is deleted after transcription, photos are not).
alter table notes add column if not exists photo_url text;
