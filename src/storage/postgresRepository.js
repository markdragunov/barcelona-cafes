/**
 * Postgres CafeRepository — Supabase / local pgvector.
 * Connects only via DATABASE_URL from the environment.
 */
import pg from "pg";
import { requireDatabaseUrl } from "../core/contracts.js";

const { Pool } = pg;

export function createPostgresRepository() {
  const databaseUrl = requireDatabaseUrl();
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.DATABASE_SSL === "disable" ? false : undefined,
  });

  function neighborhoodClause(neighborhoodId) {
    if (!neighborhoodId || neighborhoodId === "all-barcelona") {
      return { clause: "", params: [] };
    }
    return { clause: "WHERE neighborhood_id = $1", params: [neighborhoodId] };
  }

  return {
    backend: "postgres",
    pool,

    async upsertCafeWithReviews(cafe, reviews) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO cafes (
            place_id, name, address, rating, user_rating_count, website,
            place_types, latitude, longitude, neighborhood_id, neighborhood_name, updated_at
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now()
          )
          ON CONFLICT (place_id) DO UPDATE SET
            name = excluded.name,
            address = COALESCE(excluded.address, cafes.address),
            rating = COALESCE(excluded.rating, cafes.rating),
            user_rating_count = COALESCE(excluded.user_rating_count, cafes.user_rating_count),
            website = COALESCE(excluded.website, cafes.website),
            place_types = excluded.place_types,
            latitude = COALESCE(excluded.latitude, cafes.latitude),
            longitude = COALESCE(excluded.longitude, cafes.longitude),
            neighborhood_id = CASE
              WHEN cafes.neighborhood_id IS NULL OR cafes.neighborhood_id = '' THEN excluded.neighborhood_id
              ELSE cafes.neighborhood_id
            END,
            neighborhood_name = CASE
              WHEN cafes.neighborhood_name IS NULL OR cafes.neighborhood_name = '' THEN excluded.neighborhood_name
              ELSE cafes.neighborhood_name
            END,
            updated_at = now()`,
          [
            cafe.place_id,
            cafe.name,
            cafe.address ?? null,
            cafe.rating ?? null,
            cafe.user_rating_count ?? null,
            cafe.website ?? null,
            cafe.place_types ?? "[]",
            cafe.latitude ?? null,
            cafe.longitude ?? null,
            cafe.neighborhood_id ?? null,
            cafe.neighborhood_name ?? null,
          ]
        );
        for (const review of reviews) {
          await client.query(
            `INSERT INTO reviews (
              place_id, author_name, rating, text, publish_time,
              relative_publish_time_description, language_code
            ) VALUES ($1,$2,$3,$4,$5,$6,$7)
            ON CONFLICT (place_id, author_name, publish_time, text) DO NOTHING`,
            [
              review.place_id,
              review.author_name ?? null,
              review.rating ?? null,
              review.text ?? null,
              review.publish_time ?? null,
              review.relative_publish_time_description ?? null,
              review.language_code ?? null,
            ]
          );
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },

    async getSummary(neighborhoodId) {
      const { clause, params } = neighborhoodClause(neighborhoodId);
      const { rows } = await pool.query(
        `SELECT
          COUNT(*)::int AS total_cafes,
          ROUND(AVG(rating)::numeric, 2) AS average_rating,
          COUNT(*) FILTER (WHERE website IS NOT NULL AND website != '')::int AS with_website,
          COUNT(*) FILTER (WHERE user_rating_count IS NOT NULL AND user_rating_count > 0)::int AS with_reviews,
          COUNT(*) FILTER (WHERE latitude IS NOT NULL AND longitude IS NOT NULL)::int AS with_coordinates
        FROM cafes ${clause}`,
        params
      );
      const row = rows[0] || {};
      return {
        total_cafes: Number(row.total_cafes ?? 0),
        average_rating: row.average_rating != null ? Number(row.average_rating) : null,
        with_website: Number(row.with_website ?? 0),
        with_reviews: Number(row.with_reviews ?? 0),
        with_coordinates: Number(row.with_coordinates ?? 0),
      };
    },

    async getCafesForExport(neighborhoodId) {
      const { clause, params } = neighborhoodClause(neighborhoodId);
      const { rows: cafes } = await pool.query(
        `SELECT place_id, name, address, rating, user_rating_count, website,
                place_types, latitude, longitude, neighborhood_id, neighborhood_name,
                coffee_content
         FROM cafes ${clause} ORDER BY lower(name)`,
        params
      );
      if (cafes.length === 0) return [];
      const ids = cafes.map((cafe) => cafe.place_id);
      const { rows: reviews } = await pool.query(
        `SELECT place_id, author_name, rating, text, publish_time,
                relative_publish_time_description, language_code
         FROM reviews WHERE place_id = ANY($1)
         ORDER BY publish_time DESC NULLS LAST`,
        [ids]
      );
      return attachReviews(cafes, reviews);
    },

    async getCafesNeedingCoffeeContent(neighborhoodId) {
      const filters = [
        "website IS NOT NULL",
        "TRIM(website) != ''",
        "(coffee_content IS NULL OR TRIM(coffee_content) = '')",
      ];
      const params = [];
      if (neighborhoodId && neighborhoodId !== "all-barcelona") {
        params.push(neighborhoodId);
        filters.push(`neighborhood_id = $${params.length}`);
      }
      const { rows } = await pool.query(
        `SELECT place_id, name, website, neighborhood_id, neighborhood_name
         FROM cafes WHERE ${filters.join(" AND ")} ORDER BY lower(name)`,
        params
      );
      return rows;
    },

    async countCafesWithCoffeeContent(neighborhoodId) {
      const filters = [
        "website IS NOT NULL",
        "TRIM(website) != ''",
        "coffee_content IS NOT NULL",
        "TRIM(coffee_content) != ''",
      ];
      const params = [];
      if (neighborhoodId && neighborhoodId !== "all-barcelona") {
        params.push(neighborhoodId);
        filters.push(`neighborhood_id = $${params.length}`);
      }
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM cafes WHERE ${filters.join(" AND ")}`,
        params
      );
      return Number(rows[0]?.n ?? 0);
    },

    async updateCoffeeContent(placeId, coffeeContent) {
      await pool.query(
        `UPDATE cafes SET coffee_content = $1, updated_at = now() WHERE place_id = $2`,
        [coffeeContent, placeId]
      );
    },

    async getCafeCount() {
      const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM cafes`);
      return Number(rows[0]?.n ?? 0);
    },

    async listCafeCoordinates() {
      const { rows } = await pool.query(
        `SELECT place_id, latitude, longitude FROM cafes
         WHERE latitude IS NOT NULL AND longitude IS NOT NULL`
      );
      return rows;
    },

    async listKnownPlaceIds() {
      const { rows } = await pool.query(`SELECT place_id FROM cafes`);
      return rows.map((row) => row.place_id);
    },
  };
}

function attachReviews(cafes, reviews) {
  const byPlace = new Map();
  for (const review of reviews) {
    const { place_id: placeId, ...rest } = review;
    if (!byPlace.has(placeId)) byPlace.set(placeId, []);
    byPlace.get(placeId).push(rest);
  }
  return cafes.map((cafe) => ({
    ...cafe,
    reviews: byPlace.get(cafe.place_id) || [],
  }));
}
