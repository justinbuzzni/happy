/*
 * specs/managed-cloud-byos P4 — tool executor 의 신뢰 실행 helper.
 *
 * broker 가 넘긴 도구 호출은 **여기를 통해서만** 실행된다. 계획을 읽는 것이
 * 아니라 계획을 **집행**한다 — namespace 진입, `/proc` 재마운트, fd 정리,
 * 권한 강등이 전부 이 프로세스 안에서 exec 전에 끝난다.
 *
 * 순서:
 *   ⓪ 자기 PID 를 **세대 cgroup** 에 넣는다 — 자식이 이 소속을 상속하므로
 *      세대 fence(`cgroup.kill`)와 취소가 도구 프로세스까지 닿는다
 *   ① unshare(PID|MOUNT|NET) — 새 namespace 를 연다
 *   ② fork — 자식이 새 PID namespace 의 1번이 된다
 *   ③ (자식) mount 전파를 private 으로 만들고 `/proc` 을 hidepid=2 로 다시 마운트
 *   ④ (자식) fd allowlist: 허용된 것만 남기고 닫는다
 *   ⑤ (자식) capability bounding drop → setgroups → setgid → setuid → no_new_privs
 *   ⑥ (자식) ACK(pid) → **release 대기** → execve
 *
 * ⑥ 의 대기가 network 설정 자리다. 새 net namespace 에는 `lo` 뿐이라 밖으로
 * 나가지 못한다 — supervisor 가 자식의 `/proc/<pid>/ns/net` 을 잡아 veth 와
 * 규칙을 넣은 **뒤에** release 를 보낸다. 순서를 바꾸면 규칙 없는 구간이 생긴다.
 *
 * 부모는 자식의 **부모 namespace 기준 pid** 를 알린다. 그 값이 없으면
 * supervisor 가 어느 namespace 를 설정해야 할지 알 수 없다.
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <limits.h>
#include <linux/capability.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#define EXEC_PREFIX "/usr/local/lib/saycode/"
#define CGROUP_PREFIX "/sys/fs/cgroup/saycode/"
/* 실행 디렉터리는 여기 박아 둔다. caller 가 고를 수 있으면 경계가 아니다. */
#define WORKDIR "/workspace/project"
/* 강등 대상 UID/GID 범위. setuid-root 바이너리가 임의 UID 를 받으면
 * 호출자가 곧 권한 상승 경로가 된다. */
#define MIN_TOOL_ID 10600
#define MAX_TOOL_ID 10699

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

/*
 * execve 대상이 신뢰 파일인지 확인한다.
 *
 * 접두어 문자열만 보면 `\/usr/local/lib/saycode/x -> /tmp/evil` 심볼릭 링크가
 * 통과한다. 그래서 링크 자체를 거부하고(`lstat`), 소유자가 root 이며 그룹·기타
 * 쓰기가 없는 **일반 파일**만 받는다.
 */
static void assert_trusted_executable(const char *path) {
    if (!has_prefix(path, EXEC_PREFIX) || strstr(path, "..")) fail("stage=args");
    struct stat st;
    if (lstat(path, &st) != 0) fail("stage=exe");
    if (!S_ISREG(st.st_mode)) fail("stage=exe");
    if (st.st_uid != 0) fail("stage=exe");
    if (st.st_mode & (S_IWGRP | S_IWOTH)) fail("stage=exe");
    /* 경로 중간의 링크까지 본다. 정규화 결과가 접두어를 벗어나면 거부한다. */
    char resolved[PATH_MAX];
    if (!realpath(path, resolved)) fail("stage=exe");
    if (strcmp(resolved, path) != 0) fail("stage=exe");
}

/*
 * 호출자가 신뢰 관리자인지 본다. 이 바이너리가 setuid-root 로 설치되면
 * 아무나 실행할 수 있고, 그 순간 "임의 UID 로 격리된 실행" 이 아니라
 * "임의 UID 강등 도구" 가 된다. 실제 uid 가 root 일 때만 진행한다.
 */
static void assert_trusted_caller(void) {
    if (getuid() != 0) fail("stage=caller");
}

/*
 * 호스트 파일시스템을 그대로 물려주지 않는다.
 *
 * 새 mount namespace 는 **사본**일 뿐이라 그 자체로는 아무것도 가리지 않는다.
 * unix 소켓(`/run`)·홈·관리 상태 위에 빈 tmpfs 를 덮어 pathname 소켓과 남의
 * 홈에 닿는 경로를 없앤다. DAC 로만 막으면 권한 설정 하나가 바뀔 때 경계가
 * 사라진다.
 */
static void shield_mounts(void) {
    /*
     * `/tmp` 는 1777 이어야 한다. 0755 root 로 덮으면 강등된 도구가 `mktemp`
     * 조차 못 해 EACCES 로 죽는다 — 경계가 아니라 고장이다. 나머지는 도구가
     * 쓸 이유가 없으므로 0755 로 비워 둔다.
     */
    static const char *shielded[] = { "/run", "/tmp", "/home", "/root", "/var/lib/saycode" };
    static const char *modes[] = { "mode=0755", "mode=1777", "mode=0755", "mode=0755", "mode=0755" };
    for (size_t i = 0; i < sizeof(shielded) / sizeof(shielded[0]); i++) {
        if (mount("tmpfs", shielded[i], "tmpfs", MS_NOSUID | MS_NODEV, modes[i]) != 0) {
            /* 없는 경로는 덮을 것도 없다. 그 밖의 실패는 경계가 서지 않은 것이다. */
            if (errno == ENOENT) continue;
            fail("stage=mount-shield");
        }
    }
}

/* 자기 PID 를 세대 cgroup 에 넣는다. 실패하면 실행하지 않는다 — 취소가
 * 닿지 않는 도구 프로세스를 만드느니 아무것도 돌리지 않는 편이 낫다. */
static void join_cgroup(const char *dir) {
    char procs[PATH_MAX];
    if (snprintf(procs, sizeof(procs), "%s/cgroup.procs", dir) >= (int)sizeof(procs)) {
        errno = ENAMETOOLONG;
        fail("stage=cgroup");
    }
    int fd = open(procs, O_WRONLY | O_CLOEXEC);
    if (fd < 0) fail("stage=cgroup");
    char line[32];
    int len = snprintf(line, sizeof(line), "%d\n", (int)getpid());
    if (len <= 0 || write(fd, line, (size_t)len) != len) {
        int saved = errno;
        (void)close(fd);
        errno = saved;
        fail("stage=cgroup");
    }
    if (close(fd) != 0) fail("stage=cgroup");
}

int main(int argc, char **argv) {
    /* helper <status_fd> <release_fd> <cgroup_dir> <uid> <gid> <nkeep> <keep...> <exe> [args...] */
    if (argc < 8) {
        fprintf(stderr, "usage: executorHelper <status_fd> <release_fd> <cgroup> <uid> <gid> <nkeep> [fds...] <exe> [args...]\n");
        return 64;
    }
    char *end = NULL;
    errno = 0;
    long parsed_status = strtol(argv[1], &end, 10);
    if (errno != 0 || !end || *end != '\0' || parsed_status < 0 || parsed_status > 1024) return 64;
    status_fd = (int)parsed_status;
    if (fcntl(status_fd, F_SETFD, FD_CLOEXEC) != 0) return 64;

    errno = 0;
    long parsed_release = strtol(argv[2], &end, 10);
    if (errno != 0 || !end || *end != '\0' || parsed_release < 0 || parsed_release > 1024) return 64;
    int release_fd = (int)parsed_release;
    if (release_fd == status_fd) return 64;

    const char *cgroup_dir = argv[3];
    if (!has_prefix(cgroup_dir, CGROUP_PREFIX) || strstr(cgroup_dir, "..")) fail("stage=args");

    errno = 0;
    long uid = strtol(argv[4], &end, 10);
    if (errno != 0 || !end || *end != '\0' || uid < MIN_TOOL_ID || uid > MAX_TOOL_ID) fail("stage=args");
    errno = 0;
    long gid = strtol(argv[5], &end, 10);
    if (errno != 0 || !end || *end != '\0' || gid < MIN_TOOL_ID || gid > MAX_TOOL_ID) fail("stage=args");
    errno = 0;
    long nkeep = strtol(argv[6], &end, 10);
    if (errno != 0 || !end || *end != '\0' || nkeep < 0 || nkeep > 16) fail("stage=args");
    if (argc < 7 + nkeep + 1) fail("stage=args");

    int keep[16];
    for (long i = 0; i < nkeep; i++) {
        errno = 0;
        long fd = strtol(argv[7 + i], &end, 10);
        if (errno != 0 || !end || *end != '\0' || fd < 3 || fd > 1024) fail("stage=args");
        if ((int)fd == status_fd || (int)fd == release_fd) fail("stage=args");
        for (long j = 0; j < i; j++) if (keep[j] == (int)fd) fail("stage=args");
        keep[i] = (int)fd;
    }
    char **exec_argv = &argv[7 + nkeep];
    assert_trusted_caller();
    assert_trusted_executable(exec_argv[0]);

    /* ⓪ 세대 cgroup 에 들어간다. 아래 fork 로 만든 자식이 이 소속을
     *    그대로 물려받으므로, supervisor 의 세대 fence 와 실행 취소가
     *    같은 `cgroup.kill` 하나로 도구까지 닿는다. */
    join_cgroup(cgroup_dir);

    /* ① 새 namespace. PID 는 다음 fork 부터 적용된다. */
    if (unshare(CLONE_NEWPID | CLONE_NEWNS | CLONE_NEWNET) != 0) fail("stage=unshare");

    /* ② 자식이 새 PID namespace 의 1번이다. */
    pid_t child = fork();
    if (child < 0) fail("stage=fork");

    if (child > 0) {
        /* 부모: 자식의 **부모 namespace 기준 pid** 를 알린다. supervisor 가
         * 그 값으로 `/proc/<pid>/ns/net` 을 잡아 네트워크를 설정한다. */
        char ack[64];
        snprintf(ack, sizeof(ack), "ack=setup-complete pid=%d", (int)child);
        emit(ack);
        int status = 0;
        if (waitpid(child, &status, 0) < 0) fail("stage=wait");
        if (WIFEXITED(status)) _exit(WEXITSTATUS(status));
        _exit(70);
    }

    /* ③ mount 전파를 끊고 자기 `/proc` 을 hidepid 로 마운트한다. */
    if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) != 0) fail("stage=mount-private");
    if (mount("proc", "/proc", "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, "hidepid=2") != 0) {
        fail("stage=mount-proc");
    }
    shield_mounts();

    /* ④ 실제로 열린 fd 를 열거해 허용 목록 밖을 닫는다. */
    {
        DIR *fds = opendir("/proc/self/fd");
        if (!fds) fail("stage=fd-enumerate");
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
            for (long i = 0; i < nkeep; i++) if (keep[i] == (int)fd) keeper = 1;
            if (keeper) continue;
            if (count < (int)(sizeof(to_close) / sizeof(to_close[0]))) to_close[count++] = (int)fd;
            else fail("stage=fd-enumerate");
        }
        closedir(fds);
        for (int i = 0; i < count; i++) (void)close(to_close[i]);
        for (long i = 0; i < nkeep; i++) {
            int flags = fcntl(keep[i], F_GETFD);
            if (flags < 0 || fcntl(keep[i], F_SETFD, flags & ~FD_CLOEXEC) != 0) fail("stage=fds");
        }
    }

    /* ⑤ bounding set 은 강등 **전에** 버린다. CAP_SETPCAP 은 setuid 뒤에 없다.
     *    CAP_NET_RAW 가 여기서 사라지므로 raw socket 은 만들 수 없다. */
    for (int capability = 0; capability <= CAP_LAST_CAP; capability++) {
        if (prctl(PR_CAPBSET_DROP, capability, 0, 0, 0) != 0 && errno != EINVAL) fail("stage=caps");
    }
    if (setgroups(0, NULL) != 0) fail("stage=cred");
    if (setgid((gid_t)gid) != 0) fail("stage=cred");
    if (setuid((uid_t)uid) != 0) fail("stage=cred");
    if (getuid() != (uid_t)uid || geteuid() != (uid_t)uid) fail("stage=cred");
    if (setuid(0) == 0) fail("stage=cred");
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) fail("stage=no-new-privs");

    /* 작업 디렉터리는 고정이다. 없으면 실행하지 않는다. */
    if (chdir(WORKDIR) != 0) fail("stage=cwd");

    /* ⑥ supervisor 가 네트워크를 설정할 때까지 기다린다. */
    {
        char gate;
        ssize_t got = read(release_fd, &gate, 1);
        if (got != 1) fail("stage=release");
        (void)close(release_fd);
    }

    execv(exec_argv[0], exec_argv);
    fail("stage=exec");
    return 70;
}
