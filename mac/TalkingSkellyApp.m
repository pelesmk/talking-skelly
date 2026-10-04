#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

@interface SkellyAppDelegate : NSObject <NSApplicationDelegate, WKNavigationDelegate>
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) WKWebView *webView;
@property(nonatomic, strong) NSTask *serverProcess;
@property(nonatomic) BOOL ownsServer;
@property(nonatomic) NSInteger attempts;
@end

@implementation SkellyAppDelegate

- (NSString *)appName {
    return [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleDisplayName"] ?: @"Talking Skelly";
}

- (NSString *)deploymentMode {
    return [[NSBundle mainBundle] objectForInfoDictionaryKey:@"SkellyDeploymentMode"] ?: @"standalone";
}

- (NSInteger)serverPort {
    NSNumber *port = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"SkellyServerPort"];
    return port ? port.integerValue : 4317;
}

- (NSURL *)appURL {
    return [NSURL URLWithString:[NSString stringWithFormat:@"http://127.0.0.1:%ld/?app=1", (long)self.serverPort]];
}

- (NSURL *)statusURL {
    return [NSURL URLWithString:[NSString stringWithFormat:@"http://127.0.0.1:%ld/api/status", (long)self.serverPort]];
}

- (NSURL *)projectURL {
    NSString *path = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"SkellyProjectPath"];
    if (path.length == 0 || [path isEqualToString:@"__SKELLY_PROJECT_PATH__"]) {
        path = [NSHomeDirectory() stringByAppendingPathComponent:@"code/skelly"];
    }
    return [NSURL fileURLWithPath:path isDirectory:YES];
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    [self installMenu];
    [self installDockIcon];
    [self createWindow];
    [self showLoading:@"Waking Skelly…"];
    [self ensureServer];
    [NSApp activateIgnoringOtherApps:YES];
}

- (void)installMenu {
    NSMenu *mainMenu = [[NSMenu alloc] init];
    NSMenuItem *appItem = [[NSMenuItem alloc] init];
    [mainMenu addItem:appItem];
    NSMenu *appMenu = [[NSMenu alloc] init];

    NSMenuItem *about = [[NSMenuItem alloc] initWithTitle:[NSString stringWithFormat:@"About %@", self.appName] action:@selector(orderFrontStandardAboutPanel:) keyEquivalent:@""];
    about.target = NSApp;
    [appMenu addItem:about];
    [appMenu addItem:[NSMenuItem separatorItem]];

    NSMenuItem *reload = [[NSMenuItem alloc] initWithTitle:@"Reload Control Panel" action:@selector(reloadPanel:) keyEquivalent:@"r"];
    reload.target = self;
    [appMenu addItem:reload];
    [appMenu addItem:[NSMenuItem separatorItem]];

    NSMenuItem *quit = [[NSMenuItem alloc] initWithTitle:[NSString stringWithFormat:@"Quit %@", self.appName] action:@selector(terminate:) keyEquivalent:@"q"];
    quit.target = NSApp;
    [appMenu addItem:quit];
    appItem.submenu = appMenu;
    NSApp.mainMenu = mainMenu;
}

- (void)installDockIcon {
    NSSize size = NSMakeSize(512, 512);
    NSImage *image = [[NSImage alloc] initWithSize:size];
    [image lockFocus];
    NSRect rect = NSMakeRect(20, 20, 472, 472);
    NSBezierPath *path = [NSBezierPath bezierPathWithRoundedRect:rect xRadius:105 yRadius:105];
    NSColor *top = [NSColor colorWithCalibratedRed:0.22 green:0.10 blue:0.35 alpha:1];
    NSColor *bottom = [NSColor colorWithCalibratedRed:0.05 green:0.03 blue:0.09 alpha:1];
    [[[NSGradient alloc] initWithColors:@[top, bottom]] drawInBezierPath:path angle:-55];
    NSDictionary *attributes = @{ NSFontAttributeName: [NSFont systemFontOfSize:300] };
    NSAttributedString *emoji = [[NSAttributedString alloc] initWithString:@"💀" attributes:attributes];
    NSSize emojiSize = emoji.size;
    [emoji drawAtPoint:NSMakePoint((512 - emojiSize.width) / 2, (512 - emojiSize.height) / 2 - 6)];
    [image unlockFocus];
    NSApp.applicationIconImage = image;
}

- (void)createWindow {
    WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
    self.webView = [[WKWebView alloc] initWithFrame:NSZeroRect configuration:configuration];
    self.webView.navigationDelegate = self;
    self.window = [[NSWindow alloc]
        initWithContentRect:NSMakeRect(0, 0, 900, 760)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
        backing:NSBackingStoreBuffered
        defer:NO];
    self.window.title = self.appName;
    self.window.minSize = NSMakeSize(620, 560);
    [self.window center];
    self.window.contentView = self.webView;
    [self.window makeKeyAndOrderFront:nil];
}

- (void)showLoading:(NSString *)message {
    NSString *html = [NSString stringWithFormat:
        @"<meta name='viewport' content='width=device-width,initial-scale=1'>"
         "<style>body{margin:0;display:grid;place-items:center;height:100vh;background:#110d19;color:#f7f2ff;font:18px -apple-system}main{text-align:center}.skull{font-size:80px}p{color:#cfc2dd}</style>"
         "<main><div class='skull'>💀</div><h2>%@</h2><p>%@</p></main>", self.appName, message];
    [self.webView loadHTMLString:html baseURL:nil];
}

- (void)ensureServer {
    __weak typeof(self) weakSelf = self;
    [self checkServer:^(BOOL running) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (running) [weakSelf waitForServer];
            else [weakSelf launchServer];
        });
    }];
}

- (void)launchServer {
    NSTask *process = [[NSTask alloc] init];
    process.executableURL = [NSURL fileURLWithPath:@"/usr/bin/env"];
    process.arguments = @[@"npm", @"start"];
    process.currentDirectoryURL = self.projectURL;
    NSMutableDictionary *environment = [NSProcessInfo.processInfo.environment mutableCopy];
    environment[@"PATH"] = @"/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
    environment[@"SKELLY_DEPLOYMENT_MODE"] = self.deploymentMode;
    environment[@"SKELLY_PORT"] = [NSString stringWithFormat:@"%ld", (long)self.serverPort];
    process.environment = environment;

    NSURL *logURL = [self.projectURL URLByAppendingPathComponent:@".runtime/mac-app.log"];
    [[NSFileManager defaultManager] createDirectoryAtURL:logURL.URLByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:nil];
    if (![[NSFileManager defaultManager] fileExistsAtPath:logURL.path]) {
        [[NSFileManager defaultManager] createFileAtPath:logURL.path contents:nil attributes:nil];
    }
    NSFileHandle *log = [NSFileHandle fileHandleForWritingAtPath:logURL.path];
    [log seekToEndOfFile];
    process.standardOutput = log;
    process.standardError = log;

    NSError *error = nil;
    if ([process launchAndReturnError:&error]) {
        self.serverProcess = process;
        self.ownsServer = YES;
        [self waitForServer];
    } else {
        [self showLoading:[NSString stringWithFormat:@"Could not start the server: %@", error.localizedDescription]];
    }
}

- (void)checkServer:(void (^)(BOOL running))completion {
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:self.statusURL];
    request.timeoutInterval = 1;
    [[[NSURLSession sharedSession] dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        NSInteger status = [(NSHTTPURLResponse *)response statusCode];
        completion(status == 200);
    }] resume];
}

- (void)waitForServer {
    self.attempts += 1;
    __weak typeof(self) weakSelf = self;
    [self checkServer:^(BOOL running) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (running) {
                [weakSelf.webView loadRequest:[NSURLRequest requestWithURL:weakSelf.appURL]];
                if ([weakSelf.deploymentMode isEqualToString:@"standalone"]) [weakSelf startConversation];
            } else if (weakSelf.attempts < 50) {
                dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.4 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
                    [weakSelf waitForServer];
                });
            } else {
                [weakSelf showLoading:@"The local server did not become ready. Check .runtime/mac-app.log."];
            }
        });
    }];
}

- (void)startConversation {
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:@"http://127.0.0.1:4317/api/conversation/start"]];
    request.HTTPMethod = @"POST";
    [[[NSURLSession sharedSession] dataTaskWithRequest:request] resume];
}

- (void)reloadPanel:(id)sender {
    [self.webView loadRequest:[NSURLRequest requestWithURL:self.appURL]];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender { return YES; }

- (void)applicationWillTerminate:(NSNotification *)notification {
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:@"http://127.0.0.1:4317/api/conversation/stop"]];
    request.HTTPMethod = @"POST";
    [[[NSURLSession sharedSession] dataTaskWithRequest:request] resume];
    if (self.ownsServer && self.serverProcess.running) [self.serverProcess terminate];
}

@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSApplication *application = NSApplication.sharedApplication;
        SkellyAppDelegate *delegate = [[SkellyAppDelegate alloc] init];
        application.delegate = delegate;
        [application run];
    }
    return 0;
}
