require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { db, initDB } = require('./database');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3001;

// Initialize database
initDB();

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// Optional integrations - only initialize if API keys are present
let anthropic = null;
let stripe = null;

if (process.env.ANTHROPIC_API_KEY) {
  const Anthropic = require('@anthropic-ai/sdk');
  anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });
  console.log('✓ Anthropic AI enabled');
} else {
  console.log('⚠ Anthropic AI disabled (no API key)');
}

if (process.env.STRIPE_SECRET_KEY) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  console.log('✓ Stripe payments enabled');
} else {
  console.log('⚠ Stripe payments disabled (no API key)');
}

// Auth middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.sendStatus(401);

  jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key', (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// ============ AUTH ROUTES ============

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const userId = uuidv4();

    const stmt = db.prepare(`
      INSERT INTO users (id, email, password_hash, name)
      VALUES (?, ?, ?, ?)
    `);

    stmt.run(userId, email, hashedPassword, name);

    const token = jwt.sign({ userId, email }, process.env.JWT_SECRET || 'your-secret-key');
    res.json({ token, user: { id: userId, email, name } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET || 'your-secret-key'
    );

    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ============ EVENT ROUTES ============

app.post('/api/events', authenticateToken, async (req, res) => {
  try {
    const { 
      name, 
      description, 
      location, 
      dateTime, 
      capacity, 
      isPaid, 
      ticketPrice,
      paymentMethod,
      paymentInstructions,
      customQuestions
    } = req.body;
    
    const eventId = uuidv4();

    const stmt = db.prepare(`
      INSERT INTO events (
        id, user_id, name, description, location, date_time, capacity, 
        is_paid, ticket_price, payment_method, payment_instructions, custom_questions
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      eventId,
      req.user.userId,
      name,
      description,
      location,
      new Date(dateTime).getTime() / 1000,
      capacity,
      isPaid ? 1 : 0,
      ticketPrice || 0,
      paymentMethod || 'none',
      paymentInstructions || '',
      JSON.stringify(customQuestions || [])
    );

    res.json({ eventId, message: 'Event created successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to create event' });
  }
});

app.get('/api/events', authenticateToken, (req, res) => {
  try {
    const events = db.prepare(`
      SELECT * FROM events WHERE user_id = ? ORDER BY date_time DESC
    `).all(req.user.userId);

    res.json(events);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

app.get('/api/events/:id', authenticateToken, (req, res) => {
  try {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Get attendees
    const attendees = db.prepare('SELECT * FROM attendees WHERE event_id = ?').all(req.params.id);
    
    res.json({ ...event, attendees });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch event' });
  }
});

// ============ ATTENDEE ROUTES ============

app.post('/api/events/:id/rsvp', async (req, res) => {
  try {
    const { name, email, answers } = req.body;
    const eventId = req.params.id;
    const attendeeId = uuidv4();

    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const currentAttendees = db.prepare('SELECT COUNT(*) as count FROM attendees WHERE event_id = ?').get(eventId);
    
    if (currentAttendees.count >= event.capacity) {
      return res.status(400).json({ error: 'Event is full' });
    }

    const stmt = db.prepare(`
      INSERT INTO attendees (id, event_id, name, email, status, custom_answers)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const status = event.is_paid ? 'unpaid' : 'confirmed';
    stmt.run(attendeeId, eventId, name, email, status, JSON.stringify(answers || {}));

    res.json({ attendeeId, status, message: 'RSVP successful' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'RSVP failed' });
  }
});

app.post('/api/attendees/:id/payment', async (req, res) => {
  try {
    const attendee = db.prepare('SELECT * FROM attendees WHERE id = ?').get(req.params.id);
    if (!attendee) {
      return res.status(404).json({ error: 'Attendee not found' });
    }

    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(attendee.event_id);
    
    // Create Stripe payment intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(event.ticket_price * 100), // Convert to cents
      currency: 'usd',
      metadata: {
        attendeeId: attendee.id,
        eventId: event.id,
      },
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Payment initiation failed' });
  }
});

app.post('/api/attendees/:id/confirm-payment', (req, res) => {
  try {
    const { paymentId } = req.body;
    
    const stmt = db.prepare(`
      UPDATE attendees SET status = 'paid', payment_id = ? WHERE id = ?
    `);

    stmt.run(paymentId, req.params.id);

    res.json({ message: 'Payment confirmed' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Payment confirmation failed' });
  }
});

app.post('/api/events/:id/send-reminders', authenticateToken, (req, res) => {
  try {
    const unpaidAttendees = db.prepare(`
      SELECT * FROM attendees WHERE event_id = ? AND status = 'unpaid'
    `).all(req.params.id);

    // In production, send actual emails here
    console.log(`Sending reminders to ${unpaidAttendees.length} attendees`);

    res.json({ 
      message: `Reminders sent to ${unpaidAttendees.length} attendees`,
      count: unpaidAttendees.length
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to send reminders' });
  }
});

// ============ MESSAGES ROUTES ============

app.get('/api/events/:id/messages', (req, res) => {
  try {
    const messages = db.prepare(`
      SELECT * FROM messages WHERE event_id = ? ORDER BY created_at ASC
    `).all(req.params.id);

    res.json(messages);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

app.post('/api/events/:id/messages', (req, res) => {
  try {
    const { senderName, senderEmail, message } = req.body;
    const messageId = uuidv4();

    const stmt = db.prepare(`
      INSERT INTO messages (id, event_id, sender_name, sender_email, message)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(messageId, req.params.id, senderName, senderEmail, message);

    res.json({ messageId, message: 'Message sent' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ============ AI ROUTES ============

app.post('/api/ai/enhance-description', authenticateToken, async (req, res) => {
  try {
    if (!anthropic) {
      return res.status(503).json({ 
        error: 'AI features not available',
        message: 'Add ANTHROPIC_API_KEY to .env to enable AI features'
      });
    }

    const { description, eventName } = req.body;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: `You are helping improve an event description. Make it more compelling, engaging, and professional while keeping the core message. Event name: "${eventName}". Current description: "${description}". Return only the improved description, no preamble.`
      }]
    });

    const enhancedDescription = message.content[0].text;
    res.json({ enhancedDescription });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'AI enhancement failed' });
  }
});

app.post('/api/ai/generate-promo-ideas', authenticateToken, async (req, res) => {
  try {
    if (!anthropic) {
      // Return fallback promo ideas without AI
      const { eventName, dateTime, location, isPaid, ticketPrice } = req.body;
      const fallbackPromos = [
        {
          variant: 1,
          text: eventName,
          tagline: dateTime
        },
        {
          variant: 2,
          text: eventName.split(':')[0] || eventName.substring(0, 30),
          tagline: location
        },
        {
          variant: 3,
          text: 'Join Us',
          tagline: isPaid ? `$${ticketPrice}` : 'Free Event'
        }
      ];
      return res.json({ promoIdeas: fallbackPromos });
    }

    const { eventName, description, dateTime, location } = req.body;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `Generate 3 different promotional text variations for this event. Each should be concise (under 30 words) and suitable for social media. Event: "${eventName}", Description: "${description}", Date: "${dateTime}", Location: "${location}". Return as JSON array with format: [{"variant": 1, "text": "...headline", "tagline": "...subtext"}]`
      }]
    });

    const promoIdeas = JSON.parse(message.content[0].text);
    res.json({ promoIdeas });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Promo generation failed' });
  }
});

// ============ ANALYTICS ROUTES ============

app.get('/api/events/:id/analytics', authenticateToken, (req, res) => {
  try {
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const stats = db.prepare(`
      SELECT 
        COUNT(*) as total_attendees,
        SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) as paid_count,
        SUM(CASE WHEN status = 'unpaid' THEN 1 ELSE 0 END) as unpaid_count,
        SUM(CASE WHEN status = 'waitlist' THEN 1 ELSE 0 END) as waitlist_count
      FROM attendees WHERE event_id = ?
    `).get(req.params.id);

    const revenue = event.is_paid ? stats.paid_count * event.ticket_price : 0;

    res.json({
      ...stats,
      revenue,
      capacity: event.capacity,
      eventDate: event.date_time
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Scene server running on port ${PORT}`);
});
