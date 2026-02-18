const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'scene.db'));

// Initialize database schema
function initDB() {
  // Users table
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);

  // Events table
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      location TEXT,
      date_time INTEGER NOT NULL,
      capacity INTEGER NOT NULL,
      is_paid INTEGER DEFAULT 0,
      ticket_price REAL DEFAULT 0,
      payment_method TEXT DEFAULT 'none',
      payment_instructions TEXT,
      custom_questions TEXT,
      image_url TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Attendees table
  db.exec(`
    CREATE TABLE IF NOT EXISTS attendees (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      status TEXT DEFAULT 'unpaid',
      payment_id TEXT,
      custom_answers TEXT,
      rsvp_date INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (event_id) REFERENCES events(id)
    )
  `);

  // Messages table
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      sender_email TEXT,
      message TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (event_id) REFERENCES events(id)
    )
  `);

  // Promo content table
  db.exec(`
    CREATE TABLE IF NOT EXISTS promo_content (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      content_url TEXT NOT NULL,
      style_variant TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (event_id) REFERENCES events(id)
    )
  `);

  // Recap photos table
  db.exec(`
    CREATE TABLE IF NOT EXISTS recap_photos (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      photo_url TEXT NOT NULL,
      uploaded_by TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (event_id) REFERENCES events(id)
    )
  `);

  console.log('Database initialized successfully');
}

module.exports = { db, initDB };
