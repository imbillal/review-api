import {Router} from 'express';
import {db} from '@/db';
import {sendError, asyncHandler} from '@/lib/api';
import {getUserId} from '@/middleware/auth';
import {verifyAuthToken} from '@/lib/jwt';
import {subscribe} from '@/lib/notify';

const router: Router = Router();

router.get(
	'/',
	asyncHandler(async (req, res) => {
		const userId = await getUserId(req);
		if (!userId)
			return sendError(res, 'UNAUTHORIZED', 'Not authenticated', 401);
		const limit = Math.min(Number(req.query.limit ?? 20) || 20, 50);
		const cursor =
			typeof req.query.cursor === 'string' ? req.query.cursor : null;

		const rows = await db.notification.findMany({
			where: {userId},
			orderBy: {createdAt: 'desc'},
			take: limit,
			...(cursor ? {cursor: {id: cursor}, skip: 1} : {}),
		});

		const actorIds = Array.from(new Set(rows.map((r) => r.actorId)));
		const docIds = Array.from(new Set(rows.map((r) => r.documentId)));
		const projectIds = Array.from(new Set(rows.map((r) => r.projectId)));
		const orgIds = Array.from(new Set(rows.map((r) => r.orgId)));

		const [actors, docs, projects, orgs] = await Promise.all([
			actorIds.length
				? db.user.findMany({
						where: {id: {in: actorIds}},
						select: {id: true, name: true, email: true},
					})
				: [],
			docIds.length
				? db.document.findMany({
						where: {id: {in: docIds}},
						select: {id: true, title: true},
					})
				: [],
			projectIds.length
				? db.project.findMany({
						where: {id: {in: projectIds}},
						select: {id: true, slug: true},
					})
				: [],
			orgIds.length
				? db.organization.findMany({
						where: {id: {in: orgIds}},
						select: {id: true, slug: true},
					})
				: [],
		]);

		const actorMap = new Map(actors.map((a) => [a.id, a]));
		const docMap = new Map(docs.map((d) => [d.id, d]));
		const projectMap = new Map(projects.map((p) => [p.id, p]));
		const orgMap = new Map(orgs.map((o) => [o.id, o]));

		res.json(
			rows.map((r) => ({
				...r,
				actor: actorMap.get(r.actorId) ?? null,
				documentTitle: docMap.get(r.documentId)?.title ?? null,
				projectSlug: projectMap.get(r.projectId)?.slug ?? null,
				orgSlug: orgMap.get(r.orgId)?.slug ?? null,
			})),
		);
	}),
);

router.get(
	'/unread-count',
	asyncHandler(async (req, res) => {
		const userId = await getUserId(req);
		if (!userId)
			return sendError(res, 'UNAUTHORIZED', 'Not authenticated', 401);
		// Prisma + Mongo quirk: `readAt: null` matches zero rows. Fetch then filter.
		const rows = await db.notification.findMany({
			where: {userId},
			select: {readAt: true},
		});
		const count = rows.filter((r) => r.readAt == null).length;
		res.json({count});
	}),
);

router.patch(
	'/:id/read',
	asyncHandler(async (req, res) => {
		const userId = await getUserId(req);
		if (!userId)
			return sendError(res, 'UNAUTHORIZED', 'Not authenticated', 401);
		const id = req.params.id!;
		const row = await db.notification.findUnique({where: {id}});
		if (!row || row.userId !== userId)
			return sendError(res, 'NOT_FOUND', 'Notification not found', 404);
		if (row.readAt) return res.json(row);
		const updated = await db.notification.update({
			where: {id},
			data: {readAt: new Date()},
		});
		res.json(updated);
	}),
);

router.post(
	'/read-all',
	asyncHandler(async (req, res) => {
		const userId = await getUserId(req);
		if (!userId)
			return sendError(res, 'UNAUTHORIZED', 'Not authenticated', 401);
		// Prisma + Mongo quirk: `readAt: null` matches zero rows. Find ids then update by id list.
		const rows = await db.notification.findMany({
			where: {userId},
			select: {id: true, readAt: true},
		});
		const ids = rows.filter((r) => r.readAt == null).map((r) => r.id);
		if (ids.length === 0) return res.json({updated: 0});
		const r = await db.notification.updateMany({
			where: {id: {in: ids}},
			data: {readAt: new Date()},
		});
		res.json({updated: r.count});
	}),
);

router.get(
	'/stream',
	asyncHandler(async (req, res) => {
		// EventSource can't send custom headers, so accept a query-string token
		// here in addition to the Authorization header that other routes use.
		let userId = await getUserId(req);
		if (!userId) {
			const queryToken = typeof req.query.token === 'string' ? req.query.token : null;
			if (queryToken) {
				const payload = verifyAuthToken(queryToken);
				userId = payload?.sub ?? null;
			}
		}
		if (!userId)
			return sendError(res, 'UNAUTHORIZED', 'Not authenticated', 401);

		res.set({
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no',
		});
		res.flushHeaders();
		res.write(`event: hello\ndata: {}\n\n`);

		const heartbeat = setInterval(() => {
			res.write(`: ping\n\n`);
		}, 25_000);

		const unsub = subscribe(userId, (payload) => {
			res.write(
				`event: notification\ndata: ${JSON.stringify(payload)}\n\n`,
			);
		});

		req.on('close', () => {
			clearInterval(heartbeat);
			unsub();
		});
	}),
);

export default router;
