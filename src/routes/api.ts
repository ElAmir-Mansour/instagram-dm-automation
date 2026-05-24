import { Router } from 'express';
import { pool } from '../config/db.js';
import { createSession, requireAuth } from '../middleware/auth.js';
import axios from 'axios';
import { sendDirectMessage, publishFacebookPost, publishInstagramPost, API_VERSION } from '../services/instagram.js';
import { generateAiResponse } from '../services/ai.js';


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

// ─── Cron: Publish Scheduled Posts ──────────────────────────────────────────

router.get('/cron/publish', async (req, res) => {
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers['authorization'];
    const queryToken = req.query.token;

    if (cronSecret && authHeader !== `Bearer ${cronSecret}` && queryToken !== cronSecret) {
        res.status(401).json({ error: 'Unauthorized cron request.' });
        return;
    }

    try {
        console.log('⏰ Running Post Publisher Cron Job...');
        
        // Find pending posts due for publishing
        const result = await pool.query(`
            SELECT s.*, c.page_access_token, c.instagram_page_id, c.facebook_page_id 
            FROM scheduled_posts s
            JOIN creators c ON c.id = s.creator_id
            WHERE s.status = 'PENDING' AND s.scheduled_time <= NOW()
            ORDER BY s.scheduled_time ASC
        `);

        if (result.rows.length === 0) {
            console.log('⏰ No pending scheduled posts found.');
            res.json({ message: 'No pending posts to publish.' });
            return;
        }

        console.log(`⏰ Found ${result.rows.length} post(s) to publish.`);
        const publishedIds: string[] = [];

        for (const post of result.rows) {
            console.log(`⏰ Processing scheduled post ${post.id} (${post.platform} - ${post.post_type})...`);
            
            // Mark as publishing to prevent double-triggering
            await pool.query('UPDATE scheduled_posts SET status = $1 WHERE id = $2', ['PUBLISHING', post.id]);

            try {
                let fbId: string | null = null;
                let igId: string | null = null;

                const token = post.page_access_token;

                // 1. Publish to Facebook
                if (post.platform === 'facebook' || post.platform === 'both') {
                    if (!post.facebook_page_id) {
                        throw new Error('Facebook Page ID is missing for this creator.');
                    }
                    console.log(`⏰ Publishing to Facebook Page ${post.facebook_page_id}...`);
                    const fbRes = await publishFacebookPost(
                        post.facebook_page_id,
                        post.post_type,
                        post.caption || '',
                        post.media_url,
                        token
                    );
                    fbId = fbRes.id || fbRes.post_id;
                    console.log(`⏰ Published to Facebook. Post ID: ${fbId}`);
                }

                // 2. Publish to Instagram
                if (post.platform === 'instagram' || post.platform === 'both') {
                    if (!post.instagram_page_id) {
                        throw new Error('Instagram Account ID is missing for this creator.');
                    }
                    if (!post.media_url) {
                        throw new Error('Instagram requires a media URL to publish.');
                    }
                    console.log(`⏰ Publishing to Instagram Account ${post.instagram_page_id}...`);
                    const igRes = await publishInstagramPost(
                        post.instagram_page_id,
                        post.post_type,
                        post.caption || '',
                        post.media_url,
                        token
                    );
                    igId = igRes.id;
                    console.log(`⏰ Published to Instagram. Media ID: ${igId}`);
                }

                // Format published ID string
                let resultId = '';
                if (fbId && igId) {
                    resultId = `FB:${fbId} | IG:${igId}`;
                } else if (fbId) {
                    resultId = `FB:${fbId}`;
                } else if (igId) {
                    resultId = `IG:${igId}`;
                }

                await pool.query(
                    `UPDATE scheduled_posts 
                     SET status = 'PUBLISHED', published_post_id = $1, error_log = NULL 
                     WHERE id = $2`,
                    [resultId, post.id]
                );

                publishedIds.push(post.id);

            } catch (err: any) {
                console.error(`❌ Failed to publish scheduled post ${post.id}:`, err.message);
                await pool.query(
                    `UPDATE scheduled_posts 
                     SET status = 'FAILED', error_log = $1 
                     WHERE id = $2`,
                    [err.message, post.id]
                );
            }
        }

        res.json({
            message: `Publishing sequence complete.`,
            processed: result.rows.length,
            published: publishedIds
        });

    } catch (err: any) {
        console.error('❌ Scheduler Cron Error:', err);
        res.status(500).json({ error: 'Cron publisher failed.' });
    }
});

// ─── All routes below require authentication ────────────────────────────────
router.use(requireAuth);

// ─── Dashboard Stats ────────────────────────────────────────────────────────

router.get('/stats', async (_req, res) => {
    try {
        const [total, sent, failed, campaigns, creators, today, uniqueUsers, instagram, facebook] = await Promise.all([
            pool.query('SELECT COUNT(*)::int as count FROM interactions'),
            pool.query("SELECT COUNT(*)::int as count FROM interactions WHERE status = 'SENT'"),
            pool.query("SELECT COUNT(*)::int as count FROM interactions WHERE status = 'FAILED'"),
            pool.query('SELECT COUNT(*)::int as count FROM campaigns'),
            pool.query('SELECT COUNT(*)::int as count FROM creators WHERE is_active = true'),
            pool.query("SELECT COUNT(*)::int as count FROM interactions WHERE timestamp > NOW() - INTERVAL '24 hours'"),
            pool.query('SELECT COUNT(DISTINCT sender_username)::int as count FROM interactions'),
            pool.query("SELECT COUNT(*)::int as count FROM interactions WHERE platform = 'instagram'"),
            pool.query("SELECT COUNT(*)::int as count FROM interactions WHERE platform = 'facebook'"),
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
            instagramCount: instagram.rows[0].count,
            facebookCount: facebook.rows[0].count,
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
        const { creator_id, trigger_keyword, dm_template, public_reply_template, post_id, is_active } = req.body;

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
            `INSERT INTO campaigns (creator_id, trigger_keyword, dm_template, public_reply_template, post_id, is_active)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [creatorId, trigger_keyword, dm_template, public_reply_template || null, post_id || null, is_active !== false]
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
        const { trigger_keyword, dm_template, public_reply_template, post_id, is_active } = req.body;

        const result = await pool.query(
            `UPDATE campaigns 
             SET trigger_keyword = COALESCE($1, trigger_keyword),
                 dm_template = COALESCE($2, dm_template),
                 public_reply_template = $3,
                 post_id = $4,
                 is_active = COALESCE($5, is_active)
             WHERE id = $6 RETURNING *`,
            [
                trigger_keyword, 
                dm_template, 
                public_reply_template || null, 
                post_id || null, 
                typeof is_active === 'boolean' ? is_active : null, 
                id
            ]
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

// ─── Campaigns Stats Leaderboard ─────────────────────────────────────────────

router.get('/stats/campaigns', async (_req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                c.id,
                c.trigger_keyword,
                COUNT(i.id)::int as total_triggers,
                COUNT(i.id) FILTER (WHERE i.status = 'SENT')::int as sent_count,
                COUNT(i.id) FILTER (WHERE i.status = 'FAILED')::int as failed_count
            FROM campaigns c
            LEFT JOIN interactions i ON i.campaign_id = c.id
            GROUP BY c.id, c.trigger_keyword
            ORDER BY total_triggers DESC
            LIMIT 5
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('Campaign Stats Error:', err);
        res.status(500).json({ error: 'Failed to fetch campaign stats.' });
    }
});

// ─── Export Interactions (CSV Exporter) ──────────────────────────────────────

router.get('/interactions/export', async (req, res) => {
    try {
        const platform = req.query.platform as string;
        const campaign_id = req.query.campaign_id as string;
        const status = req.query.status as string;
        const search = req.query.search as string;

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

        if (platform && ['instagram', 'facebook'].includes(platform)) {
            params.push(platform);
            conditions.push(`i.platform = $${params.length}`);
        }

        if (campaign_id) {
            params.push(campaign_id);
            conditions.push(`i.campaign_id = $${params.length}`);
        }

        if (conditions.length > 0) {
            whereClause = 'WHERE ' + conditions.join(' AND ');
        }

        const dataQuery = `
            SELECT 
                i.timestamp,
                i.sender_username,
                i.platform,
                c.trigger_keyword,
                i.post_id,
                i.status,
                i.error_log
            FROM interactions i
            LEFT JOIN campaigns c ON c.id = i.campaign_id
            ${whereClause}
            ORDER BY i.timestamp DESC
        `;

        const result = await pool.query(dataQuery, params);

        let csv = 'Timestamp,Username,Platform,Matched Keyword,Post ID,Status,Errors\n';
        for (const row of result.rows) {
            const time = new Date(row.timestamp).toISOString();
            const username = row.sender_username.replace(/"/g, '""');
            const plat = row.platform;
            const keyword = (row.trigger_keyword || '').replace(/"/g, '""');
            const postId = (row.post_id || '').replace(/"/g, '""');
            const stat = row.status;
            const error = (row.error_log || '').replace(/"/g, '""');
            
            csv += `"${time}","${username}","${plat}","${keyword}","${postId}","${stat}","${error}"\n`;
        }

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=interactions_export.csv');
        res.status(200).send(csv);
    } catch (err) {
        console.error('Export Error:', err);
        res.status(500).json({ error: 'Failed to export interactions.' });
    }
});

// ─── Interactions (Activity Log) ────────────────────────────────────────────

router.get('/interactions', async (req, res) => {
    try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
        const status = req.query.status as string;
        const search = req.query.search as string;
        const platform = req.query.platform as string;
        const campaign_id = req.query.campaign_id as string;
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

        if (platform && ['instagram', 'facebook'].includes(platform)) {
            params.push(platform);
            conditions.push(`i.platform = $${params.length}`);
        }

        if (campaign_id) {
            params.push(campaign_id);
            conditions.push(`i.campaign_id = $${params.length}`);
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
            'SELECT id, instagram_page_id, facebook_page_id, is_active, page_access_token FROM creators LIMIT 1'
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
                instagramPageId: creator.instagram_page_id,
                facebookPageId: creator.facebook_page_id,
                pageId: creator.instagram_page_id,   // backwards compat
                isActive: creator.is_active,
            });
        } catch {
            res.json({
                status: 'invalid',
                message: 'Token validation failed — token may be expired or revoked.',
                instagramPageId: creator.instagram_page_id,
                facebookPageId: creator.facebook_page_id,
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

// ─── Posts Scheduler CRUD ────────────────────────────────────────────────────

router.get('/posts/scheduled', async (_req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM scheduled_posts ORDER BY scheduled_time DESC'
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Fetch Scheduled Posts Error:', err);
        res.status(500).json({ error: 'Failed to fetch scheduled posts.' });
    }
});

router.post('/posts/scheduled', async (req, res) => {
    try {
        const { platform, post_type, caption, media_url, scheduled_time, publish_now } = req.body;

        if (!platform || !post_type || !scheduled_time) {
            res.status(400).json({ error: 'platform, post_type, and scheduled_time are required.' });
            return;
        }

        // Get first active creator
        const creatorRes = await pool.query('SELECT id FROM creators WHERE is_active = true LIMIT 1');
        if (creatorRes.rows.length === 0) {
            res.status(400).json({ error: 'No active creator account found.' });
            return;
        }
        const creatorId = creatorRes.rows[0].id;

        // Insert into database
        const result = await pool.query(
            `INSERT INTO scheduled_posts (creator_id, platform, post_type, caption, media_url, scheduled_time, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [
                creatorId,
                platform,
                post_type,
                caption || null,
                media_url || null,
                new Date(scheduled_time),
                'PENDING'
            ]
        );

        const newPost = result.rows[0];

        if (publish_now) {
            console.log(`🚀 Immediate publishing requested for scheduled post ${newPost.id}...`);
            
            const fullCreatorRes = await pool.query(
                'SELECT page_access_token, instagram_page_id, facebook_page_id FROM creators WHERE id = $1',
                [creatorId]
            );
            const creator = fullCreatorRes.rows[0];
            const token = creator.page_access_token;

            try {
                let fbId: string | null = null;
                let igId: string | null = null;

                // Mark as publishing
                await pool.query("UPDATE scheduled_posts SET status = 'PUBLISHING' WHERE id = $1", [newPost.id]);

                // Facebook
                if (platform === 'facebook' || platform === 'both') {
                    const fbRes = await publishFacebookPost(creator.facebook_page_id, post_type, caption || '', media_url, token);
                    fbId = fbRes.id || fbRes.post_id;
                }

                // Instagram
                if (platform === 'instagram' || platform === 'both') {
                    const igRes = await publishInstagramPost(creator.instagram_page_id, post_type, caption || '', media_url, token);
                    igId = igRes.id;
                }

                let resultId = '';
                if (fbId && igId) {
                    resultId = `FB:${fbId} | IG:${igId}`;
                } else if (fbId) {
                    resultId = `FB:${fbId}`;
                } else if (igId) {
                    resultId = `IG:${igId}`;
                }

                const finalRes = await pool.query(
                    `UPDATE scheduled_posts 
                     SET status = 'PUBLISHED', published_post_id = $1, error_log = NULL 
                     WHERE id = $2 RETURNING *`,
                    [resultId, newPost.id]
                );
                res.status(201).json(finalRes.rows[0]);
                return;
            } catch (publishErr: any) {
                console.error('❌ Immediate publish failed:', publishErr.message);
                const finalRes = await pool.query(
                    `UPDATE scheduled_posts 
                     SET status = 'FAILED', error_log = $1 
                     WHERE id = $2 RETURNING *`,
                    [publishErr.message, newPost.id]
                );
                res.status(201).json(finalRes.rows[0]);
                return;
            }
        }

        res.status(201).json(newPost);
    } catch (err) {
        console.error('Create Scheduled Post Error:', err);
        res.status(500).json({ error: 'Failed to create scheduled post.' });
    }
});

router.put('/posts/scheduled/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { platform, post_type, caption, media_url, scheduled_time } = req.body;

        const result = await pool.query(
            `UPDATE scheduled_posts
             SET platform = COALESCE($1, platform),
                 post_type = COALESCE($2, post_type),
                 caption = COALESCE($3, caption),
                 media_url = COALESCE($4, media_url),
                 scheduled_time = COALESCE($5, scheduled_time)::timestamp with time zone,
                 status = CASE WHEN status = 'FAILED' THEN 'PENDING' ELSE status END
             WHERE id = $6 RETURNING *`,
            [platform, post_type, caption, media_url, scheduled_time, id]
        );

        if (result.rows.length === 0) {
            res.status(404).json({ error: 'Scheduled post not found.' });
            return;
        }
        res.json(result.rows[0]);
    } catch (err) {
        console.error('Update Scheduled Post Error:', err);
        res.status(500).json({ error: 'Failed to update scheduled post.' });
    }
});

router.delete('/posts/scheduled/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            'DELETE FROM scheduled_posts WHERE id = $1 RETURNING *',
            [id]
        );

        if (result.rows.length === 0) {
            res.status(404).json({ error: 'Scheduled post not found.' });
            return;
        }
        res.json({ message: 'Scheduled post deleted.', id });
    } catch (err) {
        console.error('Delete Scheduled Post Error:', err);
        res.status(500).json({ error: 'Failed to delete scheduled post.' });
    }
});

router.get('/posts/live', async (_req, res) => {
    try {
        const creatorRes = await pool.query(
            'SELECT page_access_token, instagram_page_id, facebook_page_id FROM creators WHERE is_active = true LIMIT 1'
        );

        if (creatorRes.rows.length === 0) {
            res.json([]);
            return;
        }

        const creator = creatorRes.rows[0];
        const token = creator.page_access_token;
        const fbPageId = creator.facebook_page_id;
        const igUserId = creator.instagram_page_id;

        const livePosts: any[] = [];
        const promises: Promise<any>[] = [];

        // Fetch FB Page Posts
        if (fbPageId && token) {
            promises.push(
                axios.get(`https://graph.facebook.com/${API_VERSION}/${fbPageId}/feed`, {
                    params: {
                        fields: 'id,message,created_time,full_picture,permalink_url',
                        access_token: token,
                        limit: 10
                    }
                }).then(response => {
                    const posts = response.data?.data || [];
                    posts.forEach((p: any) => {
                        livePosts.push({
                            id: p.id,
                            platform: 'facebook',
                            caption: p.message || '',
                            media_url: p.full_picture || null,
                            permalink: p.permalink_url || null,
                            timestamp: p.created_time
                        });
                    });
                }).catch(err => {
                    console.warn('⚠️ Failed to fetch live Facebook posts:', err.message);
                })
            );
        }

        // Fetch IG Media Posts
        if (igUserId && token) {
            promises.push(
                axios.get(`https://graph.facebook.com/${API_VERSION}/${igUserId}/media`, {
                    params: {
                        fields: 'id,caption,media_url,permalink,timestamp,media_type',
                        access_token: token,
                        limit: 10
                    }
                }).then(response => {
                    const media = response.data?.data || [];
                    media.forEach((m: any) => {
                        livePosts.push({
                            id: m.id,
                            platform: 'instagram',
                            caption: m.caption || '',
                            media_url: m.media_url || null,
                            permalink: m.permalink || null,
                            timestamp: m.timestamp
                        });
                    });
                }).catch(err => {
                    console.warn('⚠️ Failed to fetch live Instagram posts:', err.message);
                })
            );
        }

        await Promise.all(promises);

        // Sort posts descending by timestamp
        livePosts.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

        res.json(livePosts);
    } catch (err) {
        console.error('Fetch Live Posts Error:', err);
        res.status(500).json({ error: 'Failed to fetch live posts from Meta.' });
    }
});

// ─── Direct Message Inbox & Chat ─────────────────────────────────────────────

router.get('/conversations', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
        const page = parseInt(req.query.page as string) || 1;
        const offset = (page - 1) * limit;

        const result = await pool.query(
            `SELECT c.*, 
                    (SELECT text FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_text,
                    (SELECT direction FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_direction
             FROM conversations c
             ORDER BY c.last_message_at DESC
             LIMIT $1 OFFSET $2`,
            [limit, offset]
        );

        const countRes = await pool.query('SELECT COUNT(*)::int as total FROM conversations');

        res.json({
            data: result.rows,
            pagination: {
                page,
                limit,
                total: countRes.rows[0].total,
                totalPages: Math.ceil(countRes.rows[0].total / limit)
            }
        });
    } catch (err) {
        console.error('Fetch Conversations Error:', err);
        res.status(500).json({ error: 'Failed to fetch conversations.' });
    }
});

router.get('/conversations/:id/messages', async (req, res) => {
    try {
        const { id } = req.params;
        const messages = await pool.query(
            'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 100',
            [id]
        );
        res.json(messages.rows);
    } catch (err) {
        console.error('Fetch Messages Error:', err);
        res.status(500).json({ error: 'Failed to fetch message history.' });
    }
});

router.post('/conversations/:id/messages', async (req, res) => {
    try {
        const { id } = req.params;
        const { text } = req.body;

        if (!text) {
            res.status(400).json({ error: 'Message text is required.' });
            return;
        }

        // Fetch conversation and creator credentials
        const convRes = await pool.query(
            `SELECT c.*, cr.page_access_token 
             FROM conversations c
             JOIN creators cr ON cr.id = c.creator_id
             WHERE c.id = $1`,
            [id]
        );

        if (convRes.rows.length === 0) {
            res.status(404).json({ error: 'Conversation not found.' });
            return;
        }

        const conv = convRes.rows[0];

        // Send message to Instagram
        console.log(`✉️ Manual response to ${conv.instagram_user_id}: "${text}"`);
        const metaPayload = { text };
        await sendDirectMessage(conv.instagram_user_id, metaPayload, conv.page_access_token);

        // Save message to database & pause the bot to avoid fighting the user
        await pool.query(
            `INSERT INTO messages (conversation_id, direction, message_type, text, raw_payload)
             VALUES ($1, 'outbound', 'text', $2, $3)`,
            [id, text, JSON.stringify(metaPayload)]
        );

        await pool.query(
            'UPDATE conversations SET last_message_at = NOW(), is_bot_active = false WHERE id = $1',
            [id]
        );

        res.json({ success: true, message: 'Message sent manually. Bot is paused for this thread.' });
    } catch (err: any) {
        console.error('Manual Send Error:', err);
        res.status(500).json({ error: err.message || 'Failed to send message.' });
    }
});

router.put('/conversations/:id/toggle-bot', async (req, res) => {
    try {
        const { id } = req.params;
        const { is_bot_active } = req.body;

        if (typeof is_bot_active !== 'boolean') {
            res.status(400).json({ error: 'is_bot_active must be a boolean.' });
            return;
        }

        const result = await pool.query(
            'UPDATE conversations SET is_bot_active = $1 WHERE id = $2 RETURNING *',
            [is_bot_active, id]
        );

        if (result.rows.length === 0) {
            res.status(404).json({ error: 'Conversation not found.' });
            return;
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Toggle Bot Error:', err);
        res.status(500).json({ error: 'Failed to toggle bot.' });
    }
});

// ─── AI Agent Settings ───────────────────────────────────────────────────────

router.get('/settings/ai', async (_req, res) => {
    try {
        const creatorRes = await pool.query('SELECT id FROM creators WHERE is_active = true LIMIT 1');
        if (creatorRes.rows.length === 0) {
            res.status(400).json({ error: 'No active creator found.' });
            return;
        }
        const creatorId = creatorRes.rows[0].id;

        const agentRes = await pool.query('SELECT * FROM ai_agents WHERE creator_id = $1', [creatorId]);
        if (agentRes.rows.length === 0) {
            res.json({
                system_prompt: 'أنت مساعد ذكي يجيب على استفسارات المتابعين باللغة العربية.',
                knowledge_base: '',
                model: 'gemini-2.5-flash',
                temperature: 0.7,
                is_active: true
            });
            return;
        }

        res.json(agentRes.rows[0]);
    } catch (err) {
        console.error('Get AI Settings Error:', err);
        res.status(500).json({ error: 'Failed to fetch AI settings.' });
    }
});

router.post('/settings/ai', async (req, res) => {
    try {
        const { system_prompt, knowledge_base, model, temperature, is_active } = req.body;

        if (!system_prompt) {
            res.status(400).json({ error: 'System prompt is required.' });
            return;
        }

        const creatorRes = await pool.query('SELECT id FROM creators WHERE is_active = true LIMIT 1');
        if (creatorRes.rows.length === 0) {
            res.status(400).json({ error: 'No active creator found.' });
            return;
        }
        const creatorId = creatorRes.rows[0].id;

        const result = await pool.query(
            `INSERT INTO ai_agents (creator_id, system_prompt, knowledge_base, model, temperature, is_active)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (creator_id) 
             DO UPDATE SET 
                system_prompt = EXCLUDED.system_prompt,
                knowledge_base = EXCLUDED.knowledge_base,
                model = EXCLUDED.model,
                temperature = EXCLUDED.temperature,
                is_active = EXCLUDED.is_active
             RETURNING *`,
            [
                creatorId,
                system_prompt,
                knowledge_base || '',
                model || 'gemini-2.5-flash',
                parseFloat(temperature) || 0.7,
                is_active !== false
            ]
        );

        res.json(result.rows[0]);
    } catch (err) {
        console.error('Update AI Settings Error:', err);
        res.status(500).json({ error: 'Failed to update AI settings.' });
    }
});

router.post('/settings/ai/test', async (req, res) => {
    try {
        const { system_prompt, knowledge_base, user_message } = req.body;

        if (!user_message) {
            res.status(400).json({ error: 'user_message is required.' });
            return;
        }

        const creatorRes = await pool.query('SELECT id FROM creators WHERE is_active = true LIMIT 1');
        if (creatorRes.rows.length === 0) {
            res.status(400).json({ error: 'No active creator found.' });
            return;
        }
        const creatorId = creatorRes.rows[0].id;

        const mockConvId = '00000000-0000-0000-0000-000000000000';

        await pool.query(
            `INSERT INTO ai_agents (creator_id, system_prompt, knowledge_base, model, temperature, is_active)
             VALUES ($1, $2, $3, 'gemini-2.5-flash', 0.7, true)
             ON CONFLICT (creator_id) 
             DO UPDATE SET 
                system_prompt = EXCLUDED.system_prompt,
                knowledge_base = EXCLUDED.knowledge_base`,
            [creatorId, system_prompt, knowledge_base || '']
        );

        const aiRes = await generateAiResponse(mockConvId, user_message, creatorId);
        res.json(aiRes);
    } catch (err: any) {
        console.error('AI Test Error:', err);
        res.status(500).json({ error: err.message || 'Simulation call failed.' });
    }
});

export default router;
