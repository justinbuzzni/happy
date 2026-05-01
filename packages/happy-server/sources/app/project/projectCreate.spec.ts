import { describe, it, expect, vi, beforeEach } from "vitest";

// projectCreate uses the prisma `db` directly (no inTx), so the mock target
// is `@/storage/db`. Each test sets the in-memory fakes per case.
let projectFindUnique: any;
let projectCreateMock: any;

vi.mock("@/storage/db", () => ({
    db: {
        get project() {
            return {
                findUnique: projectFindUnique,
                create: projectCreateMock,
            };
        },
    },
}));

import { projectCreate } from "./projectCreate";

function makeCtx(uid: string) {
    return { uid } as any;
}

function makeRecord(overrides: Partial<{
    id: string;
    accountId: string;
    name: string;
}> = {}) {
    return {
        id: "p1",
        accountId: "user-1",
        name: "P",
        description: "",
        color: "#6366f1",
        config: null,
        isDefault: false,
        createdAt: new Date(0),
        updatedAt: new Date(0),
        ...overrides,
    };
}

describe("projectCreate", () => {
    beforeEach(() => {
        projectFindUnique = vi.fn();
        projectCreateMock = vi.fn();
    });

    it("returns existing project when id exists for the same caller (idempotent)", async () => {
        const existing = makeRecord({ id: "p1", accountId: "user-1" });
        projectFindUnique.mockResolvedValue(existing);

        const result = await projectCreate(makeCtx("user-1"), {
            id: "p1",
            name: "Anything",
        });

        expect(result).toEqual({ ok: true, value: existing });
        // Idempotent path must not hit create.
        expect(projectCreateMock).not.toHaveBeenCalled();
    });

    it("returns 'id-taken' when id exists but belongs to a different account", async () => {
        // Why: aplus-platform projects use a globally-unique id (cuid-style)
        // that may collide across happy-server accounts when the same user
        // operates in multiple contexts (personal vs company-scoped happy
        // identity, see specs/company-scoped-happy-identity). Falling
        // through to db.project.create() raises Prisma P2002 (unique
        // constraint) and surfaces as a 500 in routes — masking the real
        // semantic ("this id is reserved by another account") and producing
        // an opaque "서버 동기화 실패" toast in the web-ui.
        const existing = makeRecord({ id: "p1", accountId: "OWNER-OTHER" });
        projectFindUnique.mockResolvedValue(existing);

        const result = await projectCreate(makeCtx("user-1"), {
            id: "p1",
            name: "Anything",
        });

        expect(result).toEqual({ ok: false, error: "id-taken" });
        // Must short-circuit BEFORE attempting create — otherwise Prisma
        // raises the unique-constraint error we're guarding against.
        expect(projectCreateMock).not.toHaveBeenCalled();
    });

    it("creates a new project when id is provided and does not yet exist", async () => {
        projectFindUnique.mockResolvedValue(null);
        const created = makeRecord({ id: "p1", accountId: "user-1" });
        projectCreateMock.mockResolvedValue(created);

        const result = await projectCreate(makeCtx("user-1"), {
            id: "p1",
            name: "Fresh",
        });

        expect(result).toEqual({ ok: true, value: created });
        expect(projectCreateMock).toHaveBeenCalledWith({
            data: expect.objectContaining({
                id: "p1",
                accountId: "user-1",
                name: "Fresh",
            }),
        });
    });

    it("creates a new project when id is omitted (server-generated cuid)", async () => {
        const created = makeRecord({ id: "auto-id", accountId: "user-1" });
        projectCreateMock.mockResolvedValue(created);

        const result = await projectCreate(makeCtx("user-1"), {
            name: "Auto",
        });

        expect(result).toEqual({ ok: true, value: created });
        // findUnique must be skipped when no id is provided — otherwise we
        // do an unnecessary round-trip on the hot path.
        expect(projectFindUnique).not.toHaveBeenCalled();
        expect(projectCreateMock).toHaveBeenCalledWith({
            data: expect.objectContaining({
                accountId: "user-1",
                name: "Auto",
            }),
        });
        // The data object must NOT include an id field — let Prisma's
        // @default(cuid()) populate it.
        const call = projectCreateMock.mock.calls[0][0];
        expect(call.data.id).toBeUndefined();
    });
});
