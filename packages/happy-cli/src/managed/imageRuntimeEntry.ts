/**
 * What the managed runtime image installs as a single CommonJS file.
 *
 * The image needs two things from this package at paths of its own: the tool
 * workload the isolated executor runs, and the layout check the build runs
 * against itself. Both come from here, through the package's ordinary build —
 * `pnpm run build` emits it from the `./managed/image` export — so a clean
 * checkout produces the image's artefacts with one command and nothing is
 * assembled by hand on the side.
 *
 * One file rather than a tree because it is installed read-only next to a
 * read-only stub: a directory of modules would be a directory of modes to keep
 * right, and the executor's trusted-exec check is only as good as the least
 * protected file it can reach.
 */
export { defaultToolWorkloadDeps, runToolWorkloadCall } from '@/launcher/toolWorkloadEntry';
export {
    assertManagedImageLayout,
    MANAGED_IMAGE_ARTIFACTS,
    MANAGED_IMAGE_PROGRAMS,
    MANAGED_TOOL_WORKLOAD_PATH,
} from './managedImagePackaging';
