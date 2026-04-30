import {Router} from 'express';
import {z} from 'zod';
import {db} from '@/db';
import {slugify, ensureUniqueSlug} from '@/lib/slug';
import {sendError, parseBody, handlePrismaError, asyncHandler} from '@/lib/api';
import {requireAuth, requireAccess} from '@/middleware/auth';
import {generateToken} from '@/lib/tokens';
import {sendEmail, inviteEmailHtml} from '@/lib/email';

const router: Router = Router();
const createSchema = z.object({name: z.string().min(1).max(120)});
const updateSchema = z.object({name: z.string().min(1).max(120).optional()});
const inviteSchema = z.object({
	email: z.string().email().toLowerCase(),
	role: z.enum(['ADMIN', 'REVIEWER']),
});
const inviteProjectsSchema = z.object({
	email: z.string().email().toLowerCase(),
	role: z.enum(['ADMIN', 'REVIEWER']),
	projectIds: z.array(z.string()).min(1),
});
const patchMemberSchema = z.object({role: z.enum(['ADMIN', 'REVIEWER'])});

router.get(
	'/',
	requireAuth(),
	asyncHandler(async (req, res) => {
		const userId = req.userId!;
		type Row = {
			id: string;
			name: string;
			slug: string;
			ownerId: string;
			createdAt: Date;
			role: 'ADMIN' | 'REVIEWER' | null;
			joinedAt: Date;
		};
		const byId = new Map<string, Row>();
		const bump = (
			orgId: string,
			org: {id: string; name: string; slug: string; ownerId: string; createdAt: Date},
			role: 'ADMIN' | 'REVIEWER' | null,
			joinedAt: Date,
		) => {
			const existing = byId.get(orgId);
			if (!existing) {
				byId.set(orgId, {...org, role, joinedAt});
				return;
			}
			byId.set(orgId, {
				...org,
				role: existing.role ?? role,
				joinedAt: joinedAt > existing.joinedAt ? joinedAt : existing.joinedAt,
			});
		};

		const orgRows = await db.orgMember.findMany({
			where: {userId},
			include: {org: true},
		});
		for (const r of orgRows) bump(r.orgId, r.org, r.role, r.joinedAt);

		const projectRows = await db.projectMember.findMany({
			where: {userId},
			include: {project: {include: {org: true}}},
		});
		for (const pm of projectRows) {
			bump(pm.project.orgId, pm.project.org, null, pm.joinedAt);
		}

		const docRows = await db.documentMember.findMany({
			where: {userId},
			include: {document: {include: {project: {include: {org: true}}}}},
		});
		for (const dm of docRows) {
			bump(dm.document.project.orgId, dm.document.project.org, null, dm.joinedAt);
		}

		const result = Array.from(byId.values()).sort(
			(a, b) => b.joinedAt.getTime() - a.joinedAt.getTime(),
		);
		res.json(result.map(({joinedAt: _j, ...rest}) => rest));
	}),
);

router.post(
	'/',
	requireAuth(),
	asyncHandler(async (req, res) => {
		const parsed = parseBody(req.body, createSchema);
		if (!parsed.ok)
			return sendError(
				res,
				'VALIDATION_FAILED',
				'Invalid body',
				422,
				parsed.details,
			);
		const base = slugify(parsed.data.name);
		try {
			const slug = await ensureUniqueSlug(base, async (s) => {
				const row = await db.organization.findUnique({
					where: {slug: s},
				});
				return row != null;
			});
			const org = await db.organization.create({
				data: {
					name: parsed.data.name,
					slug,
					ownerId: req.userId!,
					members: {create: {userId: req.userId!, role: 'ADMIN'}},
				},
			});
			res.status(201).json(org);
		} catch (e) {
			if (handlePrismaError(e, res)) return;
			throw e;
		}
	}),
);

router.patch(
	'/:orgId',
	requireAccess('ADMIN', (req) => ({kind: 'org', orgId: req.params.orgId!})),
	asyncHandler(async (req, res) => {
		const parsed = parseBody(req.body, updateSchema);
		if (!parsed.ok)
			return sendError(
				res,
				'VALIDATION_FAILED',
				'Invalid body',
				422,
				parsed.details,
			);
		try {
			const org = await db.organization.update({
				where: {id: req.params.orgId!},
				data: parsed.data,
			});
			res.json(org);
		} catch (e) {
			if (handlePrismaError(e, res)) return;
			throw e;
		}
	}),
);

router.delete(
	'/:orgId',
	requireAccess('ADMIN', (req) => ({kind: 'org', orgId: req.params.orgId!})),
	asyncHandler(async (req, res) => {
		const org = await db.organization.findUnique({
			where: {id: req.params.orgId!},
		});
		if (!org) return sendError(res, 'NOT_FOUND', 'Org not found', 404);
		if (org.ownerId !== req.userId!)
			return sendError(res, 'FORBIDDEN', 'Only owner can delete', 403);
		await db.organization.delete({where: {id: req.params.orgId!}});
		res.json({ok: true});
	}),
);

router.get(
	'/:orgId/members',
	requireAccess('REVIEWER', (req) => ({
		kind: 'org',
		orgId: req.params.orgId!,
	})),
	asyncHandler(async (req, res) => {
		const rows = await db.orgMember.findMany({
			where: {orgId: req.params.orgId!},
			include: {
				user: {
					select: {
						id: true,
						name: true,
						email: true,
						avatarUrl: true,
					},
				},
			},
			orderBy: {joinedAt: 'asc'},
		});
		res.json(rows);
	}),
);

router.post(
	'/:orgId/members/invite',
	requireAccess('ADMIN', (req) => ({kind: 'org', orgId: req.params.orgId!})),
	asyncHandler(async (req, res) => {
		const parsed = parseBody(req.body, inviteSchema);
		if (!parsed.ok)
			return sendError(
				res,
				'VALIDATION_FAILED',
				'Invalid body',
				422,
				parsed.details,
			);
		const token = generateToken();
		const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
		const [invite, org, inviter] = await Promise.all([
			db.invite.create({
				data: {
					email: parsed.data.email,
					scopeType: 'ORG',
					scopeId: req.params.orgId!,
					role: parsed.data.role,
					token,
					expiresAt,
					invitedBy: req.userId!,
				},
			}),
			db.organization.findUniqueOrThrow({where: {id: req.params.orgId!}}),
			db.user.findUniqueOrThrow({where: {id: req.userId!}}),
		]);
		const acceptUrl = `${process.env.APP_URL}/invite/${token}`;
		const email = await sendEmail({
			to: parsed.data.email,
			subject: `${inviter.name} invited you to ${org.name}`,
			html: inviteEmailHtml({
				inviterName: inviter.name,
				scopeLabel: org.name,
				acceptUrl,
			}),
		});
		res.status(201).json({
			id: invite.id,
			email: invite.email,
			email_status: email,
		});
	}),
);

router.post(
	'/:orgId/members/invite-projects',
	requireAccess('ADMIN', (req) => ({kind: 'org', orgId: req.params.orgId!})),
	asyncHandler(async (req, res) => {
		const parsed = parseBody(req.body, inviteProjectsSchema);
		if (!parsed.ok)
			return sendError(res, 'VALIDATION_FAILED', 'Invalid body', 422, parsed.details);
		const orgId = req.params.orgId!;
		const projects = await db.project.findMany({
			where: {id: {in: parsed.data.projectIds}, orgId},
			select: {id: true, name: true},
		});
		if (projects.length !== parsed.data.projectIds.length) {
			return sendError(res, 'INVALID_PROJECTS', 'One or more projects do not belong to this org', 422);
		}
		const token = generateToken();
		const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
		const [invite, inviter] = await Promise.all([
			db.invite.create({
				data: {
					email: parsed.data.email,
					scopeType: 'PROJECT',
					scopeId: parsed.data.projectIds[0]!,
					scopeIds: parsed.data.projectIds,
					role: parsed.data.role,
					token,
					expiresAt,
					invitedBy: req.userId!,
				},
			}),
			db.user.findUniqueOrThrow({where: {id: req.userId!}}),
		]);
		const acceptUrl = `${process.env.APP_URL}/invite/${token}`;
		const scopeLabel = projects.map((p) => p.name).join(', ');
		const email = await sendEmail({
			to: parsed.data.email,
			subject: `${inviter.name} invited you to ${projects.length === 1 ? projects[0]!.name : `${projects.length} projects`}`,
			html: inviteEmailHtml({inviterName: inviter.name, scopeLabel, acceptUrl}),
		});
		res.status(201).json({id: invite.id, email: invite.email, email_status: email});
	}),
);

router.patch(
	'/:orgId/members/:userId',
	requireAccess('ADMIN', (req) => ({kind: 'org', orgId: req.params.orgId!})),
	asyncHandler(async (req, res) => {
		const targetUserId = req.params.userId!;
		if (targetUserId === req.userId!) {
			return sendError(
				res,
				'SELF_FORBIDDEN',
				'You cannot change your own role',
				409,
			);
		}
		const org = await db.organization.findUnique({
			where: {id: req.params.orgId!},
		});
		if (org?.ownerId === targetUserId) {
			return sendError(
				res,
				'OWNER_LOCKED',
				"The org owner's role cannot be changed",
				409,
			);
		}
		const parsed = parseBody(req.body, patchMemberSchema);
		if (!parsed.ok)
			return sendError(
				res,
				'VALIDATION_FAILED',
				'Invalid body',
				422,
				parsed.details,
			);
		const updated = await db.orgMember.update({
			where: {
				userId_orgId: {userId: targetUserId, orgId: req.params.orgId!},
			},
			data: {role: parsed.data.role},
		});
		res.json(updated);
	}),
);

router.delete(
	'/:orgId/members/:userId',
	requireAccess('ADMIN', (req) => ({kind: 'org', orgId: req.params.orgId!})),
	asyncHandler(async (req, res) => {
		const targetUserId = req.params.userId!;
		if (targetUserId === req.userId!) {
			return sendError(
				res,
				'SELF_FORBIDDEN',
				'You cannot remove yourself',
				409,
			);
		}
		const org = await db.organization.findUnique({
			where: {id: req.params.orgId!},
		});
		if (org?.ownerId === targetUserId) {
			return sendError(
				res,
				'OWNER_LOCKED',
				'The org owner cannot be removed',
				409,
			);
		}
		const admins = await db.orgMember.count({
			where: {orgId: req.params.orgId!, role: 'ADMIN'},
		});
		const target = await db.orgMember.findUnique({
			where: {
				userId_orgId: {userId: targetUserId, orgId: req.params.orgId!},
			},
		});
		if (target?.role === 'ADMIN' && admins <= 1) {
			return sendError(
				res,
				'LAST_ADMIN',
				'Cannot remove the last admin',
				409,
			);
		}
		await db.orgMember.delete({
			where: {
				userId_orgId: {userId: targetUserId, orgId: req.params.orgId!},
			},
		});
		res.json({ok: true});
	}),
);

export default router;
