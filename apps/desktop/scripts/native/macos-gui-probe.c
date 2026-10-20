#include <stdio.h>
#include <mach/mach.h>
#include <servers/bootstrap.h>

// A read-only lookup diagnostic. It does not initialize AppKit, create a
// window, send a service message, or change the caller's permissions.
int main(void) {
  const char *names[] = {
    "com.apple.coreservices.launchservicesd",
    "com.apple.windowserver.active"
  };
  printf("{\"services\":[");
  for (int i = 0; i < 2; i++) {
    mach_port_t port = MACH_PORT_NULL;
    kern_return_t result = bootstrap_look_up(bootstrap_port, names[i], &port);
    printf("%s{\"name\":\"%s\",\"code\":%d}", i ? "," : "", names[i], result);
    if (result == KERN_SUCCESS) mach_port_deallocate(mach_task_self(), port);
  }
  printf("]}\n");
  return 0;
}
