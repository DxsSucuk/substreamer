CREATE TABLE `album_artists` (
	`album_id` text NOT NULL,
	`pos` integer NOT NULL,
	`artist_id` text,
	`artist_name` text,
	PRIMARY KEY(`album_id`, `pos`),
	FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `album_disc_titles` (
	`album_id` text NOT NULL,
	`disc` integer NOT NULL,
	`title` text NOT NULL,
	PRIMARY KEY(`album_id`, `disc`),
	FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `album_genres` (
	`album_id` text NOT NULL,
	`pos` integer NOT NULL,
	`name` text NOT NULL,
	PRIMARY KEY(`album_id`, `pos`),
	FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `album_moods` (
	`album_id` text NOT NULL,
	`pos` integer NOT NULL,
	`mood` text NOT NULL,
	PRIMARY KEY(`album_id`, `pos`),
	FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `album_record_labels` (
	`album_id` text NOT NULL,
	`pos` integer NOT NULL,
	`name` text NOT NULL,
	PRIMARY KEY(`album_id`, `pos`),
	FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `album_release_types` (
	`album_id` text NOT NULL,
	`pos` integer NOT NULL,
	`name` text NOT NULL,
	PRIMARY KEY(`album_id`, `pos`),
	FOREIGN KEY (`album_id`) REFERENCES `albums`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `albums` (
	`id` text PRIMARY KEY NOT NULL,
	`artist_id` text,
	`name` text,
	`artist` text,
	`display_artist` text,
	`cover_art` text,
	`song_count` integer,
	`duration` integer,
	`play_count` integer,
	`created` integer,
	`starred` integer,
	`year` integer,
	`genre` text,
	`played` text,
	`user_rating` integer,
	`version` text,
	`music_brainz_id` text,
	`sort_name` text,
	`sort_title` text,
	`sort_artist` text,
	`is_compilation` integer,
	`explicit_status` text,
	`original_release_year` integer,
	`original_release_month` integer,
	`original_release_day` integer,
	`release_year` integer,
	`release_month` integer,
	`release_day` integer,
	`notes` text,
	`last_fm_url` text,
	`image_url_small` text,
	`image_url_medium` text,
	`image_url_large` text,
	`norm_name` text,
	`norm_artist` text,
	`dmeta_name` text,
	`dmeta_artist` text
);
--> statement-breakpoint
CREATE INDEX `idx_albums_sort` ON `albums` (`sort_title`,`id`);--> statement-breakpoint
CREATE INDEX `idx_albums_artist_sort` ON `albums` (`sort_artist`,`sort_title`,`id`);--> statement-breakpoint
CREATE INDEX `idx_albums_artist` ON `albums` (`artist_id`);--> statement-breakpoint
CREATE INDEX `idx_albums_starred` ON `albums` (`starred`,`sort_title`,`id`) WHERE "albums"."starred" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_albums_created` ON `albums` (`created`);--> statement-breakpoint
CREATE INDEX `idx_albums_norm_name` ON `albums` (`norm_name`);--> statement-breakpoint
CREATE INDEX `idx_albums_dmeta_name` ON `albums` (`dmeta_name`);--> statement-breakpoint
CREATE INDEX `idx_albums_dmeta_artist` ON `albums` (`dmeta_artist`);--> statement-breakpoint
CREATE TABLE `artist_roles` (
	`artist_id` text NOT NULL,
	`pos` integer NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`artist_id`, `pos`),
	FOREIGN KEY (`artist_id`) REFERENCES `artists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `artist_similar` (
	`artist_id` text NOT NULL,
	`pos` integer NOT NULL,
	`similar_artist_id` text,
	`name` text,
	PRIMARY KEY(`artist_id`, `pos`),
	FOREIGN KEY (`artist_id`) REFERENCES `artists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `artists` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`sort_name` text,
	`sort_title` text,
	`cover_art` text,
	`artist_image_url` text,
	`album_count` integer,
	`starred` integer,
	`user_rating` integer,
	`music_brainz_id` text,
	`biography` text,
	`last_fm_url` text,
	`image_url_small` text,
	`image_url_medium` text,
	`image_url_large` text,
	`norm_name` text,
	`dmeta_name` text
);
--> statement-breakpoint
CREATE INDEX `idx_artists_sort` ON `artists` (`sort_title`,`id`);--> statement-breakpoint
CREATE INDEX `idx_artists_starred` ON `artists` (`starred`,`sort_title`,`id`) WHERE "artists"."starred" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_artists_norm_name` ON `artists` (`norm_name`);--> statement-breakpoint
CREATE INDEX `idx_artists_dmeta_name` ON `artists` (`dmeta_name`);--> statement-breakpoint
CREATE TABLE `playlist_allowed_users` (
	`playlist_id` text NOT NULL,
	`pos` integer NOT NULL,
	`username` text NOT NULL,
	PRIMARY KEY(`playlist_id`, `pos`),
	FOREIGN KEY (`playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `playlist_songs` (
	`playlist_id` text NOT NULL,
	`position` integer NOT NULL,
	`song_id` text NOT NULL,
	PRIMARY KEY(`playlist_id`, `position`),
	FOREIGN KEY (`playlist_id`) REFERENCES `playlists`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_playlist_songs_song` ON `playlist_songs` (`song_id`);--> statement-breakpoint
CREATE TABLE `playlists` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`comment` text,
	`cover_art` text,
	`created` integer,
	`changed` integer,
	`duration` integer,
	`owner` text,
	`public` integer,
	`song_count` integer,
	`sort_title` text,
	`norm_name` text,
	`dmeta_name` text
);
--> statement-breakpoint
CREATE INDEX `idx_playlists_sort_title` ON `playlists` (`sort_title`,`id`);--> statement-breakpoint
CREATE INDEX `idx_playlists_norm_name` ON `playlists` (`norm_name`);--> statement-breakpoint
CREATE TABLE `song_album_artists` (
	`song_id` text NOT NULL,
	`pos` integer NOT NULL,
	`artist_id` text,
	`artist_name` text,
	PRIMARY KEY(`song_id`, `pos`),
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `song_artists` (
	`song_id` text NOT NULL,
	`pos` integer NOT NULL,
	`artist_id` text,
	`artist_name` text,
	PRIMARY KEY(`song_id`, `pos`),
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `song_contributors` (
	`song_id` text NOT NULL,
	`pos` integer NOT NULL,
	`role` text NOT NULL,
	`sub_role` text,
	`artist_id` text,
	`artist_name` text,
	PRIMARY KEY(`song_id`, `pos`),
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `song_genres` (
	`song_id` text NOT NULL,
	`pos` integer NOT NULL,
	`name` text NOT NULL,
	PRIMARY KEY(`song_id`, `pos`),
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `song_moods` (
	`song_id` text NOT NULL,
	`pos` integer NOT NULL,
	`mood` text NOT NULL,
	PRIMARY KEY(`song_id`, `pos`),
	FOREIGN KEY (`song_id`) REFERENCES `songs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `songs` (
	`id` text PRIMARY KEY NOT NULL,
	`album_id` text,
	`artist_id` text,
	`title` text,
	`album` text,
	`artist` text,
	`display_artist` text,
	`display_album_artist` text,
	`display_composer` text,
	`track` integer,
	`disc_number` integer,
	`year` integer,
	`genre` text,
	`cover_art` text,
	`duration` integer,
	`size` integer,
	`content_type` text,
	`suffix` text,
	`transcoded_content_type` text,
	`transcoded_suffix` text,
	`bit_rate` integer,
	`bit_depth` integer,
	`sampling_rate` integer,
	`channel_count` integer,
	`path` text,
	`user_rating` integer,
	`average_rating` real,
	`play_count` integer,
	`created` integer,
	`starred` integer,
	`played` text,
	`type` text,
	`bpm` integer,
	`comment` text,
	`sort_name` text,
	`sort_title` text,
	`sort_artist` text,
	`music_brainz_id` text,
	`explicit_status` text,
	`bookmark_position` integer,
	`is_video` integer,
	`is_dir` integer,
	`parent` text,
	`original_width` integer,
	`original_height` integer,
	`rg_track_gain` real,
	`rg_album_gain` real,
	`rg_track_peak` real,
	`rg_album_peak` real,
	`rg_base_gain` real,
	`rg_fallback_gain` real,
	`norm_title` text,
	`norm_artist` text,
	`dmeta_title` text,
	`dmeta_artist` text
);
--> statement-breakpoint
CREATE INDEX `idx_songs_sort` ON `songs` (`sort_title`,`id`);--> statement-breakpoint
CREATE INDEX `idx_songs_artist_sort` ON `songs` (`sort_artist`,`sort_title`,`id`);--> statement-breakpoint
CREATE INDEX `idx_songs_album` ON `songs` (`album_id`);--> statement-breakpoint
CREATE INDEX `idx_songs_artist` ON `songs` (`artist_id`);--> statement-breakpoint
CREATE INDEX `idx_songs_starred` ON `songs` (`starred`,`sort_title`,`id`) WHERE "songs"."starred" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_songs_norm_title` ON `songs` (`norm_title`);--> statement-breakpoint
CREATE INDEX `idx_songs_dmeta_title` ON `songs` (`dmeta_title`);--> statement-breakpoint
CREATE INDEX `idx_songs_dmeta_artist` ON `songs` (`dmeta_artist`);