/*
 * specs/managed-cloud-byos §5.36 — managed 세대의 신뢰 실행 helper.
 *
 * root 소유 실행 파일이며 supervisor 의 **root 자식**으로만 실행된다. 하는 일은
 * 고정 순서 하나뿐이고, 어느 단계든 실패하면 **exec 하지 않고** 죽는다.
 *
 *   ① 자기 PID 를 세대 cgroup.procs 에 기록
 *   ② (P4) namespace 진입 — 아직 구현하지 않았다. 비어 있는 함수도 두지 않는다.
 *   ③ fd allowlist: 허용된 fd 만 남기고 닫는다
 *   ④ capability bounding set drop → setgroups → setgid → setuid
 *   ⑤ PR_SET_NO_NEW_PRIVS
 *   ⑥ ACK(pid 포함) → **release 를 기다린다** → execve
 *
 * ⑥ 의 대기가 경합을 닫는다. workload 가 곧바로 보고를 보내면 그 보고가 launch
 * 등록보다 먼저 도착할 수 있다. 그래서 supervisor 가 PID 를 받아 등록을 마친 뒤
 * release 바이트를 보내야 exec 이 일어난다. release 파이프가 그냥 닫히면 exec
 * 하지 않는다 — 등록되지 않은 세대가 도는 것보다 안 도는 편이 낫다.
 *
 * **순서가 계약이다.** bounding set 을 버리려면 CAP_SETPCAP 이 필요한데 그것은
 * setuid 직후 사라진다. 그래서 강등보다 **먼저** 버린다. `no_new_privs` 는
 * setuid 뒤에 걸어야 그 뒤의 setuid 바이너리가 권한을 되찾지 못한다.
 *
 * supervisor 는 이 프로세스를 통해서만 세대 cgroup 에 프로세스를 넣는다 —
 * supervisor 자신은 세대 cgroup 에 절대 들어가지 않는다. 들어가면 그 세대를
 * 향한 cgroup.kill 이 신뢰 관리자까지 죽인다.
 *
 * 신뢰 입력만 받는다: 실행 파일·uid·gid·cgroup 경로는 supervisor 의 설정에서
 * 오고, 여기서 한 번 더 고정 접두사를 확인한다. IPC 호출자가 고른 값이 그대로
 * 여기에 도달하는 경로는 없어야 하며, 이 검사는 그 사실에 기대지 않는 이중 방어다.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/prctl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <dirent.h>
#include <grp.h>
#include <limits.h>
/* CAP_LAST_CAP 상수만 쓴다. cap_* 함수를 쓰지 않으므로 libcap-dev 가 필요 없다. */
#include <linux/capability.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

/* 신뢰 경로 접두사. 설정이 어긋나도 임의 경로를 실행하지 않는다. */
#define CGROUP_PREFIX "/sys/fs/cgroup/saycode/"
#define EXEC_PREFIX "/usr/local/lib/saycode/"

/* 부모가 분기하는 고정 코드. 자유 텍스트를 싣지 않는다. */
static const char *STAGE_ARGS = "stage=args";
static const char *STAGE_FDLIST = "stage=fd-enumerate";
static const char *STAGE_CGROUP = "stage=cgroup";
static const char *STAGE_FDS = "stage=fds";
static const char *STAGE_CAPS = "stage=caps";
static const char *STAGE_CRED = "stage=cred";
static const char *STAGE_NNP = "stage=no-new-privs";
static const char *STAGE_RELEASE = "stage=release";
static const char *STAGE_EXEC = "stage=exec";

/* ACK 는 setup 완료와 PID 만 뜻한다. exec 성공의 증명이 아니다. */

static int status_fd = -1;

static void emit(const char *record) {
    if (status_fd >= 0) {
        (void)!write(status_fd, record, strlen(record));
        (void)!write(status_fd, "\n", 1);
    }
}

static void fail(const char *stage) {
    char buf[64];
    snprintf(buf, sizeof(buf), "%s errno=%d", stage, errno);
    emit(buf);
    _exit(70);
}

static int has_prefix(const char *value, const char *prefix) {
    return strncmp(value, prefix, strlen(prefix)) == 0;
}

/* `..` 를 허용하면 접두사 검사가 아무것도 막지 못한다. */
static int has_dotdot(const char *value) {
    return strstr(value, "..") != NULL;
}

int main(int argc, char **argv) {
    /* argv: helper <status_fd> <release_fd> <cgroup_dir> <uid> <gid> <nkeep> <keep...> <exe> [args...] */
    if (argc < 8) {
        fprintf(stderr, "usage: execHelper <status_fd> <release_fd> <cgroup> <uid> <gid> <nkeep> [fds...] <exe> [args...]\n");
        return 64;
    }
    /* strtol 은 범위를 넘으면 LONG_MAX/LONG_MIN 을 돌려주고 errno 를 세운다.
     * 그것을 확인하지 않으면 잘린 값이 uid_t 로 들어가 다른 계정이 된다. */
    char *end = NULL;
    errno = 0;
    long parsed_status = strtol(argv[1], &end, 10);
    if (errno != 0 || !end || *end != '\0' || parsed_status < 0 || parsed_status > 1024) return 64;
    status_fd = (int)parsed_status;
    /* 이 파이프는 exec 시 닫혀야 부모가 EOF 로 exec 을 관측한다. */
    if (fcntl(status_fd, F_SETFD, FD_CLOEXEC) != 0) return 64;

    errno = 0;
    long parsed_release = strtol(argv[2], &end, 10);
    if (errno != 0 || !end || *end != '\0' || parsed_release < 0 || parsed_release > 1024) return 64;
    int release_fd = (int)parsed_release;
    if (release_fd == status_fd) return 64;
    if (fcntl(release_fd, F_SETFD, FD_CLOEXEC) != 0) return 64;

    const char *cgroup_dir = argv[3];
    /* uid/gid 는 uid_t/gid_t 로 잘리면 안 된다. 32bit 범위를 명시로 막는다. */
    errno = 0;
    long uid = strtol(argv[4], &end, 10);
    if (errno != 0 || !end || *end != '\0' || uid <= 0 || uid > 2147483646L) fail(STAGE_ARGS);
    errno = 0;
    long gid = strtol(argv[5], &end, 10);
    if (errno != 0 || !end || *end != '\0' || gid <= 0 || gid > 2147483646L) fail(STAGE_ARGS);
    errno = 0;
    long nkeep = strtol(argv[6], &end, 10);
    if (errno != 0 || !end || *end != '\0' || nkeep < 0 || nkeep > 16) fail(STAGE_ARGS);
    if (argc < 7 + nkeep + 1) fail(STAGE_ARGS);

    int keep[16];
    for (long i = 0; i < nkeep; i++) {
        errno = 0;
        long fd = strtol(argv[7 + i], &end, 10);
        if (errno != 0 || !end || *end != '\0' || fd < 3 || fd > 1024) fail(STAGE_ARGS);
        /* status fd 가 keep 에 있으면 아래에서 CLOEXEC 가 풀려 부모가 EOF 로
         * exec 을 관측할 수 없게 된다. 중복도 같은 이유로 거부한다. */
        if ((int)fd == status_fd || (int)fd == release_fd) fail(STAGE_ARGS);
        for (long j = 0; j < i; j++) {
            if (keep[j] == (int)fd) fail(STAGE_ARGS);
        }
        keep[i] = (int)fd;
    }
    char **exec_argv = &argv[7 + nkeep];
    const char *exe = exec_argv[0];

    if (!has_prefix(cgroup_dir, CGROUP_PREFIX) || has_dotdot(cgroup_dir)) fail(STAGE_ARGS);
    if (!has_prefix(exe, EXEC_PREFIX) || has_dotdot(exe)) fail(STAGE_ARGS);

    /* ① cgroup 배치. 실패하면 exec 하지 않는다. */
    char procs[512];
    if (snprintf(procs, sizeof(procs), "%s/cgroup.procs", cgroup_dir) >= (int)sizeof(procs)) {
        fail(STAGE_ARGS);
    }
    int cg = open(procs, O_WRONLY | O_CLOEXEC);
    if (cg < 0) fail(STAGE_CGROUP);
    char pid[32];
    int pid_len = snprintf(pid, sizeof(pid), "%d", (int)getpid());
    if (write(cg, pid, (size_t)pid_len) != pid_len) fail(STAGE_CGROUP);
    if (close(cg) != 0) fail(STAGE_CGROUP);

    /* ② namespace 진입은 P4 다. 여기에 아무것도 하지 않는 함수를 두지 않는다. */

    /* ③ fd allowlist. **실제로 열려 있는 fd 를 열거해서** 닫는다.
     * 고정 상한까지 훑으면 그보다 높은 번호의 fd 가 그대로 상속된다. */
    {
        DIR *fds = opendir("/proc/self/fd");
        if (!fds) fail(STAGE_FDLIST);
        int dir_fd = dirfd(fds);
        int to_close[4096];
        int count = 0;
        struct dirent *entry;
        while ((entry = readdir(fds)) != NULL) {
            if (entry->d_name[0] == '.') continue;
            errno = 0;
            char *fd_end = NULL;
            long fd = strtol(entry->d_name, &fd_end, 10);
            if (errno != 0 || !fd_end || *fd_end != '\0' || fd < 3 || fd > INT_MAX) continue;
            if ((int)fd == status_fd || (int)fd == release_fd || (int)fd == dir_fd) continue;
            int keeper = 0;
            for (long i = 0; i < nkeep; i++) {
                if (keep[i] == (int)fd) { keeper = 1; break; }
            }
            if (keeper) continue;
            /* 순회 중에 닫으면 디렉터리 스트림이 흔들린다. 모아서 나중에 닫는다. */
            if (count < (int)(sizeof(to_close) / sizeof(to_close[0]))) {
                to_close[count++] = (int)fd;
            } else {
                fail(STAGE_FDLIST);
            }
        }
        closedir(fds);
        for (int i = 0; i < count; i++) (void)close(to_close[i]);
    }
    for (long i = 0; i < nkeep; i++) {
        int flags = fcntl(keep[i], F_GETFD);
        /* 상속시킬 fd 는 CLOEXEC 이면 안 된다 — exec 뒤에 사라진다. */
        if (flags < 0 || fcntl(keep[i], F_SETFD, flags & ~FD_CLOEXEC) != 0) fail(STAGE_FDS);
    }

    /* ④ bounding set 을 **강등 전에** 버린다. CAP_SETPCAP 은 setuid 뒤에 없다. */
    for (int capability = 0; capability <= CAP_LAST_CAP; capability++) {
        if (prctl(PR_CAPBSET_DROP, capability, 0, 0, 0) != 0 && errno != EINVAL) {
            fail(STAGE_CAPS);
        }
    }
    if (setgroups(0, NULL) != 0) fail(STAGE_CRED);
    if (setgid((gid_t)gid) != 0) fail(STAGE_CRED);
    if (setuid((uid_t)uid) != 0) fail(STAGE_CRED);
    /* 강등이 실제로 일어났는지 확인한다. 되돌릴 수 있으면 강등이 아니다. */
    if (getuid() != (uid_t)uid || geteuid() != (uid_t)uid) fail(STAGE_CRED);
    if (setuid(0) == 0) fail(STAGE_CRED);

    /* ⑤ 강등 뒤에 걸어야 setuid 바이너리로 권한을 되찾지 못한다. */
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) fail(STAGE_NNP);

    {
        char ack[64];
        snprintf(ack, sizeof(ack), "ack=setup-complete pid=%d", (int)getpid());
        emit(ack);
    }

    /* ⑥ supervisor 가 등록을 마쳤다는 신호를 기다린다. 닫히면 exec 하지 않는다. */
    {
        char gate;
        ssize_t got = read(release_fd, &gate, 1);
        if (got != 1) fail(STAGE_RELEASE);
        (void)close(release_fd);
    }

    execv(exe, exec_argv);
    /* 여기 오면 exec 이 실패한 것이다. ACK 뒤에도 실패는 실패다. */
    fail(STAGE_EXEC);
    return 70;
}
