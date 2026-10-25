#include <errno.h>
#include <limits.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

extern char **environ;

int main(int argc, char **argv) {
    (void)argc;
    char executable[PATH_MAX];
    if (!realpath(argv[0], executable)) {
        perror("Cannot locate AliceGemini app");
        return 1;
    }

    char resources[PATH_MAX];
    char node[PATH_MAX];
    char server[PATH_MAX];
    char appData[PATH_MAX];
    char *lastSlash = strrchr(executable, '/');
    if (!lastSlash) return 1;
    *lastSlash = '\0';
    snprintf(resources, sizeof(resources), "%s/../Resources", executable);
    snprintf(node, sizeof(node), "%s/node", resources);
    snprintf(server, sizeof(server), "%s/app/server.mjs", resources);

    const char *home = getenv("HOME");
    if (!home || snprintf(appData, sizeof(appData), "%s/Library/Application Support/AliceGemini", home) >= (int)sizeof(appData)) {
        fprintf(stderr, "Cannot determine AliceGemini data directory\n");
        return 1;
    }
    mkdir(appData, 0700);
    setenv("APP_DATA_DIR", appData, 1);
    setenv("PORT", "8787", 1);

    if (access(node, X_OK) || access(server, R_OK)) {
        fprintf(stderr, "AliceGemini app files are missing: %s\n", resources);
        return 1;
    }

    char *openArgs[] = {"/usr/bin/open", "http://localhost:8787", NULL};
    pid_t openPid;
    if (posix_spawn(&openPid, openArgs[0], NULL, NULL, openArgs, environ) == 0) {
        usleep(700000);
    }

    char *nodeArgs[] = {node, server, NULL};
    execv(node, nodeArgs);
    perror("Cannot start AliceGemini server");
    return errno ? errno : 1;
}
