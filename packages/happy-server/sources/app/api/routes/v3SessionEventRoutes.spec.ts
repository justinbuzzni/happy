import { describe, it, expect } from 'vitest';
import { getEventsQuerySchema } from './v3SessionEventRoutes';

describe('getEventsQuerySchema', () => {
    it('defaults order to asc when the caller does not send one', () => {
        const result = getEventsQuerySchema.parse({});
        expect(result.order).toBe('asc');
    });

    it('accepts order=desc for reverse pagination', () => {
        const result = getEventsQuerySchema.parse({ order: 'desc' });
        expect(result.order).toBe('desc');
    });

    it('accepts order=asc explicitly', () => {
        const result = getEventsQuerySchema.parse({ order: 'asc' });
        expect(result.order).toBe('asc');
    });

    it('rejects any other order value with a validation error', () => {
        expect(() => getEventsQuerySchema.parse({ order: 'random' })).toThrow();
    });

    it('preserves existing after_seq / limit / type defaults alongside order', () => {
        const result = getEventsQuerySchema.parse({ order: 'desc' });
        expect(result.after_seq).toBe(0);
        expect(result.limit).toBe(100);
        expect(result.type).toBeUndefined();
    });

    it('accepts before_seq as an optional reverse cursor (coerced to number)', () => {
        const result = getEventsQuerySchema.parse({ order: 'desc', before_seq: '500' });
        expect(result.before_seq).toBe(500);
    });

    it('leaves before_seq undefined when absent', () => {
        const result = getEventsQuerySchema.parse({});
        expect(result.before_seq).toBeUndefined();
    });

    it('rejects before_seq below 1', () => {
        expect(() => getEventsQuerySchema.parse({ before_seq: 0 })).toThrow();
    });

    it('rejects sending after_seq and before_seq together (ambiguous cursor)', () => {
        expect(() =>
            getEventsQuerySchema.parse({ after_seq: 10, before_seq: 500 }),
        ).toThrow();
    });
});
