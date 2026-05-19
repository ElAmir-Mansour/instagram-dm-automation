import { Router } from 'express';
import { pool } from '../config/db.js';
import { createSession, requireAuth } from '../middleware/auth.js';
import axios from 'axios';

const router = Router();

// ─── Auth ───────────────────────────────────────────────────────────────────

router.post('/auth/login', (req, res) => {
    const { password } = req.body;
    const dashboardPassword = process.env.DASHBOARD_PASSWORD || 'admin';

    if (password !== dashboardPassword) {
        res.status(401).json({ error: 'Invalid password.' });
        return;
    }

    const token = createSession();
    res.json({ token, expiresIn: '24h' });
});

// ─── All routes below require authentication ────────────────────────────────
router.use(requireAuth);

// ─── Dashboard Stats ────────────────────────────────────────────────────────

router.get('/stats', async (_req, res) => {
    try {
        const [total, sent, failed, campaigns, creators, today, uniqueUsers] = await Promise.all([
            pool.query('SELECT COUNT(*)::int as count FROM interactions'),
            pool.query("SELECT COUNT(*)::int as count FROM interactions WHERE status = 'SENT'"),
            pool.query("SELECT COUNT(*)::int as count FROM interactions WHERE status = 'FAILED'"),
            pool.query('SELECT COUNT(*)::int as count FROM campaigns'),
            pool.query('SELECT COUNT(*)::int as count FROM creators WHERE is_active = true'),
            pool.query("SELECT COUNT(*)::int as count FROM interactions WHERE timestamp > NOW() - INTERVAL '24 hours'"),
            pool.query('SELECT COUNT(DISTINCT sender_username)::int as count FROM interactions'),
        ]);

        const totalCount = total.rows[0].count;
        const sentCount = sent.rows[0].count;

        res.json({
            totalInteractions: totalCount,
            sent: sentCount,
            failed: failed.rows[0].count,
            successRate: totalCount > 0 ? Math.round((sentCount / totalCount) * 100) : 0,
            activeCampaigns: campaigns.rows[0].count,
            activeCreators: creators.rows[0].count,
            todayActivity: today.rows[0].count,
            uniqueUsersReached: uniqueUsers.rows[0].count,
        });
    } catch (err) {
        console.error('Stats Error:', err);
        res.status(500).json({ error: 'Failed to fetch stats.' });
    }
});

// ─── Hourly Stats (for chart) ───────────────────────────────────────────────

router.get('/stats/hourly', async (req, res) => {
    try {
        const days = parseInt(req.query.days as string) || 7;
        const result = await pool.query(`
            SELECT 
                DATE_TRUNC('hour', timestamp) as hour,
                COUNT(*) FILTER (WHERE status = 'SENT')::int as sent,
                COUNT(*) FILTER (WHERE status = 'FAILED')::int as failed
            FROM interactions
            WHERE timestamp > NOW() - INTERVAL '${days} days'
            GROUP BY hour
            ORDER BY hour ASC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('Hourly Stats Error:', err);
        res.status(500).json({ error: 'Failed to fetch hourly stats.' });
    }
});

// ─── Daily Stats (for chart) ────────────────────────────────────────────────

router.get('/stats/daily', async (req, res) => {
    try {
        const days = parseInt(req.query.days as string) || 30;
        const result = await pool.query(`
            SELECT 
                DATE_TRUNC('day', timestamp)::date as day,
                COUNT(*) FILTER (WHERE status = 'SENT')::int as sent,
                COUNT(*) FILTER (WHERE status = 'FAILED')::int as failed
            FROM interactions
            WHERE timestamp > NOW() - INTERVAL '${days} days'
            GROUP BY day
            ORDER BY day ASC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('Daily Stats Error:', err);
        res.status(500).json({ error: 'Failed to fetch daily stats.' });
    }
});

// ─── Campaigns CRUD ─────────────────────────────────────────────────────────

router.get('/campaigns', async (_req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                c.*,
                COUNT(i.id)::int as total_interactions,
                COUNT(i.id) FILTER (WHERE i.status = 'SENT')::int as sent_count,
                COUNT(i.id) FILTER (WHERE i.status = 'FAILED')::int as failed_count
            FROM campaigns c
            LEFT JOIN interactions i ON i.campaign_id = c.id
            GROUP BY c.id
            ORDER BY c.created_at DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('Campaigns Error:', err);
        res.status(500).json({ error: 'Failed to fetch campaigns.' });
    }
});

router.post('/campaigns', async (req, res) => {
    try {
        const { creator_id, trigger_keyword, dm_template, public_reply_template, post_id } = req.body;

        if (!trigger_keyword || !dm_template) {
            res.status(400).json({ error: 'trigger_keyword and dm_template are required.' });
            return;
        }

        // If no creator_id provided, use the first active creator
        let creatorId = creator_id;
        if (!creatorId) {
            const creatorRes = await pool.query('SELECT id FROM creators WHERE is_active = true LIMIT 1');
            if (creatorRes.rows.length === 0) {
                res.status(400).json({ error: 'No active creator found. Add a creator first.' });
                return;
            }
            creatorId = creatorRes.rows[0].id;
        }

        const result = await pool.query(
            `INSERT INTO campaigns (creator_id, trigger_keyword, dm_template, public_reply_template, post_id)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [creatorId, trigger_keyword, dm_template, public_reply_template || null, post_id || null]
        );

        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('Create Campaign Error:', err);
        res.status(500).json({ error: 'Failed to create campaign.' });
    }
});

router.put('/campaigns/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { trigger_keyword, dm_template, public_reply_template, post_id } = req.body;

        const result = await pool.query(
            `UPDATE campaigns 
             SET trigger_keyword = COALESCE($1, trigger_keyword),
                 dm_template = COALESCE($2, dm_template),
                 public_reply_template = $3,
                 post_id = $4
             WHERE id = $5 RETURNING *`,
            [trigger_keyword, dm_template, public_reply_template || null, post_id || null, id]
        );

        if (result.rows.length === 0) {
            res.status(404).json({ error: 'Campaign not found.' });
            return;
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Update Campaign Error:', err);
        res.status(500).json({ error: 'Failed to update campaign.' });
    }
});

router.delete('/campaigns/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('DELETE FROM campaigns WHERE id = $1 RETURNING id', [id]);

        if (result.rows.length === 0) {
            res.status(404).json({ error: 'Campaign not found.' });
            return;
        }
        res.json({ message: 'Campaign deleted.', id: result.rows[0].id });
    } catch (err) {
        console.error('Delete Campaign Error:', err);
        res.status(500).json({ error: 'Failed to delete campaign.' });
    }
});

// ─── Interactions (Activity Log) ────────────────────────────────────────────

router.get('/interactions', async (req, res) => {
    try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
        const status = req.query.status as string;
        const search = req.query.search as string;
        const offset = (page - 1) * limit;

        let whereClause = '';
        const params: any[] = [];
        const conditions: string[] = [];

        if (status && ['SENT', 'FAILED', 'PENDING'].includes(status)) {
            params.push(status);
            conditions.push(`i.status = $${params.length}`);
        }

        if (search) {
            params.push(`%${search}%`);
            conditions.push(`i.sender_username ILIKE $${params.length}`);
        }

        if (conditions.length > 0) {
            whereClause = 'WHERE ' + conditions.join(' AND ');
        }

        const countQuery = `SELECT COUNT(*)::int as total FROM interactions i ${whereClause}`;
        const countResult = await pool.query(countQuery, params);

        const dataParams = [...params, limit, offset];
        const dataQuery = `
            SELECT 
                i.*,
                c.trigger_keyword
            FROM interactions i
            LEFT JOIN campaigns c ON c.id = i.campaign_id
            ${whereClause}
            ORDER BY i.timestamp DESC
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `;

        const dataResult = await pool.query(dataQuery, dataParams);

        res.json({
            data: dataResult.rows,
            pagination: {
                page,
                limit,
                total: countResult.rows[0].total,
                totalPages: Math.ceil(countResult.rows[0].total / limit),
            }
        });
    } catch (err) {
        console.error('Interactions Error:', err);
        res.status(500).json({ error: 'Failed to fetch interactions.' });
    }
});

// ─── Settings: Token Management ─────────────────────────────────────────────

router.get('/settings/token/status', async (_req, res) => {
    try {
        const creatorRes = await pool.query(
            'SELECT id, instagram_page_id, is_active, page_access_token FROM creators LIMIT 1'
        );

        if (creatorRes.rows.length === 0) {
            res.json({ status: 'no_creator', message: 'No creator account found.' });
            return;
        }

        const creator = creatorRes.rows[0];
        const token = creator.page_access_token;

        // Validate token against Meta API
        try {
            const debugRes = await axios.get('https://graph.facebook.com/debug_token', {
                params: { input_token: token, access_token: token }
            });

            const data = debugRes.data.data;
            res.json({
                status: data.is_valid ? 'valid' : 'invalid',
                type: data.type,
                expiresAt: data.expires_at ? new Date(data.expires_at * 1000).toISOString() : null,
                scopes: data.scopes || [],
                pageId: creator.instagram_page_id,
                isActive: creator.is_active,
            });
        } catch {
            res.json({
                status: 'invalid',
                message: 'Token validation failed — token may be expired or revoked.',
                pageId: creator.instagram_page_id,
                isActive: creator.is_active,
            });
        }
    } catch (err) {
        console.error('Token Status Error:', err);
        res.status(500).json({ error: 'Failed to check token status.' });
    }
});

router.post('/settings/token', async (req, res) => {
    try {
        const { token } = req.body;

        if (!token) {
            res.status(400).json({ error: 'Token is required.' });
            return;
        }

        // Validate the new token
        const debugRes = await axios.get('https://graph.facebook.com/debug_token', {
            params: { input_token: token, access_token: token }
        });

        const data = debugRes.data.data;

        if (!data.is_valid) {
            res.status(400).json({ error: 'Invalid token — Meta rejected it.' });
            return;
        }

        if (data.type !== 'PAGE') {
            res.status(400).json({ error: `Wrong token type: "${data.type}". You need a PAGE Access Token.` });
            return;
        }

        // Update the token in the database
        const result = await pool.query(
            'UPDATE creators SET page_access_token = $1 WHERE is_active = true RETURNING instagram_page_id',
            [token]
        );

        if (result.rows.length === 0) {
            res.status(404).json({ error: 'No active creator found to update.' });
            return;
        }

        res.json({
            message: 'Token updated successfully!',
            pageId: result.rows[0].instagram_page_id,
            type: data.type,
            expiresAt: data.expires_at ? new Date(data.expires_at * 1000).toISOString() : null,
            scopes: data.scopes || [],
        });
    } catch (err: any) {
        console.error('Token Update Error:', err);
        res.status(500).json({ error: err.response?.data?.error?.message || 'Failed to update token.' });
    }
});

// ─── Creators ───────────────────────────────────────────────────────────────

router.get('/creators', async (_req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, instagram_page_id, is_active, created_at FROM creators ORDER BY created_at DESC'
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Creators Error:', err);
        res.status(500).json({ error: 'Failed to fetch creators.' });
    }
});

export default router;
