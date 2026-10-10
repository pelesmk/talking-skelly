#import <Cocoa/Cocoa.h>
#import <AVFoundation/AVFoundation.h>

@interface SkellyRemoteDelegate : NSObject <NSApplicationDelegate, AVAudioPlayerDelegate>
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) NSTextField *serverField;
@property(nonatomic, strong) NSSecureTextField *tokenField;
@property(nonatomic, strong) NSTextField *statusLabel;
@property(nonatomic, strong) NSTextField *transcriptLabel;
@property(nonatomic, strong) NSTextField *replyLabel;
@property(nonatomic, strong) NSButton *startButton;
@property(nonatomic, strong) NSButton *flushButton;
@property(nonatomic, strong) AVAudioRecorder *recorder;
@property(nonatomic, strong) AVAudioPlayer *player;
@property(nonatomic, strong) NSURLSessionDataTask *turnTask;
@property(nonatomic, strong) NSTimer *meterTimer;
@property(nonatomic, strong) NSTimer *heartbeatTimer;
@property(nonatomic, strong) NSURL *recordingURL;
@property(nonatomic) BOOL running;
@property(nonatomic) BOOL heardSpeech;
@property(nonatomic) NSTimeInterval listeningStarted;
@property(nonatomic) NSTimeInterval speechCandidateStarted;
@property(nonatomic) NSTimeInterval speechStarted;
@property(nonatomic) NSTimeInterval silenceStarted;
@property(nonatomic) float noiseFloorDb;
@property(nonatomic) NSUInteger noiseSampleCount;
@property(nonatomic) NSUInteger localGeneration;
@property(nonatomic, copy) NSString *currentState;
@property(nonatomic, copy) NSString *currentDetail;
@end

@implementation SkellyRemoteDelegate

- (NSTextField *)label:(NSString *)text frame:(NSRect)frame size:(CGFloat)size weight:(NSFontWeight)weight {
    NSTextField *label = [NSTextField labelWithString:text];
    label.frame = frame;
    label.font = [NSFont systemFontOfSize:size weight:weight];
    return label;
}

- (NSTextField *)bubbleWithFrame:(NSRect)frame {
    NSTextField *field = [[NSTextField alloc] initWithFrame:frame];
    field.editable = NO;
    field.selectable = YES;
    field.bezeled = YES;
    field.drawsBackground = YES;
    field.backgroundColor = [NSColor colorWithCalibratedRed:0.12 green:0.10 blue:0.16 alpha:1];
    field.textColor = NSColor.labelColor;
    field.lineBreakMode = NSLineBreakByWordWrapping;
    field.maximumNumberOfLines = 0;
    [field.cell setWraps:YES];
    return field;
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    [self installMenu];
    [self createWindow];
    [NSApp activateIgnoringOtherApps:YES];
}

- (void)installMenu {
    NSMenu *mainMenu = [[NSMenu alloc] init];
    NSMenuItem *appItem = [[NSMenuItem alloc] init];
    [mainMenu addItem:appItem];
    NSMenu *appMenu = [[NSMenu alloc] init];
    NSMenuItem *about = [[NSMenuItem alloc] initWithTitle:@"About Talking Skelly Remote" action:@selector(orderFrontStandardAboutPanel:) keyEquivalent:@""];
    about.target = NSApp;
    [appMenu addItem:about];
    [appMenu addItem:[NSMenuItem separatorItem]];
    NSMenuItem *quit = [[NSMenuItem alloc] initWithTitle:@"Quit Talking Skelly Remote" action:@selector(terminate:) keyEquivalent:@"q"];
    quit.target = NSApp;
    [appMenu addItem:quit];
    appItem.submenu = appMenu;
    NSApp.mainMenu = mainMenu;
}

- (void)createWindow {
    self.window = [[NSWindow alloc]
        initWithContentRect:NSMakeRect(0, 0, 760, 650)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable
        backing:NSBackingStoreBuffered
        defer:NO];
    self.window.title = @"Talking Skelly Remote";
    [self.window center];
    NSView *view = self.window.contentView;

    [view addSubview:[self label:@"Talking Skelly Remote" frame:NSMakeRect(28, 590, 704, 42) size:30 weight:NSFontWeightBold]];
    NSTextField *subtitle = [self label:@"MacBook ears and speaker · Mac Ultra private AI brain" frame:NSMakeRect(30, 564, 700, 24) size:15 weight:NSFontWeightRegular];
    subtitle.textColor = NSColor.secondaryLabelColor;
    [view addSubview:subtitle];

    [view addSubview:[self label:@"Private AI address" frame:NSMakeRect(30, 520, 140, 24) size:13 weight:NSFontWeightSemibold]];
    self.serverField = [[NSTextField alloc] initWithFrame:NSMakeRect(170, 515, 560, 30)];
    self.serverField.placeholderString = @"http://cheetah.local:4318";
    self.serverField.stringValue = [[NSUserDefaults standardUserDefaults] stringForKey:@"SkellyRemoteServerURL"] ?: @"http://cheetah.local:4318";
    [view addSubview:self.serverField];

    [view addSubview:[self label:@"Access token" frame:NSMakeRect(30, 478, 140, 24) size:13 weight:NSFontWeightSemibold]];
    self.tokenField = [[NSSecureTextField alloc] initWithFrame:NSMakeRect(170, 473, 560, 30)];
    self.tokenField.placeholderString = @"Copy from the backend control panel";
    self.tokenField.stringValue = [[NSUserDefaults standardUserDefaults] stringForKey:@"SkellyRemoteToken"] ?: @"";
    [view addSubview:self.tokenField];

    NSButton *testButton = [[NSButton alloc] initWithFrame:NSMakeRect(30, 420, 150, 36)];
    testButton.title = @"Test connection";
    testButton.bezelStyle = NSBezelStyleRounded;
    testButton.target = self;
    testButton.action = @selector(testConnection:);
    [view addSubview:testButton];

    self.startButton = [[NSButton alloc] initWithFrame:NSMakeRect(192, 420, 356, 36)];
    self.startButton.title = @"Start voice chat";
    self.startButton.bezelStyle = NSBezelStyleRounded;
    self.startButton.keyEquivalent = @"\r";
    self.startButton.target = self;
    self.startButton.action = @selector(toggleConversation:);
    [view addSubview:self.startButton];

    self.flushButton = [[NSButton alloc] initWithFrame:NSMakeRect(560, 420, 170, 36)];
    self.flushButton.title = @"Flush current turn";
    self.flushButton.bezelStyle = NSBezelStyleRounded;
    self.flushButton.target = self;
    self.flushButton.action = @selector(flushCurrentTurn:);
    [view addSubview:self.flushButton];

    self.statusLabel = [self bubbleWithFrame:NSMakeRect(30, 362, 700, 42)];
    self.statusLabel.stringValue = @"Enter the Mac Ultra address and token, then test the connection.";
    [view addSubview:self.statusLabel];

    [view addSubview:[self label:@"Visitor" frame:NSMakeRect(30, 328, 700, 24) size:13 weight:NSFontWeightBold]];
    self.transcriptLabel = [self bubbleWithFrame:NSMakeRect(30, 250, 700, 72)];
    self.transcriptLabel.stringValue = @"—";
    [view addSubview:self.transcriptLabel];

    [view addSubview:[self label:@"Skelly" frame:NSMakeRect(30, 216, 700, 24) size:13 weight:NSFontWeightBold]];
    self.replyLabel = [self bubbleWithFrame:NSMakeRect(30, 105, 700, 105)];
    self.replyLabel.stringValue = @"—";
    [view addSubview:self.replyLabel];

    NSTextField *note = [self label:@"Uses the microphone and output selected in macOS Sound settings. Listening pauses while Skelly speaks." frame:NSMakeRect(30, 54, 700, 38) size:13 weight:NSFontWeightRegular];
    note.textColor = NSColor.secondaryLabelColor;
    note.lineBreakMode = NSLineBreakByWordWrapping;
    note.maximumNumberOfLines = 2;
    [view addSubview:note];

    [self.window makeKeyAndOrderFront:nil];
}

- (NSString *)baseURL {
    NSString *value = [self.serverField.stringValue stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    while ([value hasSuffix:@"/"]) value = [value substringToIndex:value.length - 1];
    return value;
}

- (void)saveSettings {
    [[NSUserDefaults standardUserDefaults] setObject:self.baseURL forKey:@"SkellyRemoteServerURL"];
    [[NSUserDefaults standardUserDefaults] setObject:self.tokenField.stringValue forKey:@"SkellyRemoteToken"];
}

- (NSMutableURLRequest *)requestForPath:(NSString *)path method:(NSString *)method {
    NSURL *url = [NSURL URLWithString:[self.baseURL stringByAppendingString:path]];
    if (!url) return nil;
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
    request.HTTPMethod = method;
    request.timeoutInterval = 120;
    [request setValue:[NSString stringWithFormat:@"Bearer %@", self.tokenField.stringValue] forHTTPHeaderField:@"Authorization"];
    return request;
}

- (void)setStatus:(NSString *)state detail:(NSString *)detail {
    self.currentState = state;
    self.currentDetail = detail ?: @"";
    self.statusLabel.stringValue = self.currentDetail.length ? [NSString stringWithFormat:@"%@ — %@", state.capitalizedString, self.currentDetail] : state.capitalizedString;
}

- (NSString *)errorMessageFromData:(NSData *)data fallback:(NSString *)fallback {
    if (!data.length) return fallback;
    NSDictionary *json = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    return [json[@"error"] isKindOfClass:NSString.class] ? json[@"error"] : fallback;
}

- (void)performHealthCheck:(void (^)(BOOL ok, NSString *message))completion {
    NSMutableURLRequest *request = [self requestForPath:@"/api/remote/health" method:@"GET"];
    if (!request || self.tokenField.stringValue.length == 0) {
        completion(NO, @"Enter the private AI address and access token.");
        return;
    }
    [[[NSURLSession sharedSession] dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        NSInteger status = [(NSHTTPURLResponse *)response statusCode];
        NSString *message = error.localizedDescription ?: [self errorMessageFromData:data fallback:[NSString stringWithFormat:@"Server returned %ld", (long)status]];
        dispatch_async(dispatch_get_main_queue(), ^{ completion(status == 200, status == 200 ? @"Connected to the private AI on the Mac Ultra." : message); });
    }] resume];
}

- (void)testConnection:(id)sender {
    [self saveSettings];
    [self setStatus:@"connecting" detail:@"Checking the Mac Ultra…"];
    [self performHealthCheck:^(BOOL ok, NSString *message) {
        [self setStatus:ok ? @"ready" : @"error" detail:message];
    }];
}

- (void)toggleConversation:(id)sender {
    if (self.running) {
        [self stopConversation];
        return;
    }
    [self saveSettings];
    [self setStatus:@"connecting" detail:@"Checking the Mac Ultra…"];
    [self performHealthCheck:^(BOOL ok, NSString *message) {
        if (!ok) {
            [self setStatus:@"error" detail:message];
            return;
        }
        [self requestMicrophoneAndStart];
    }];
}

- (void)requestMicrophoneAndStart {
    AVAuthorizationStatus authorization = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
    if (authorization == AVAuthorizationStatusAuthorized) {
        [self startConversation];
    } else if (authorization == AVAuthorizationStatusNotDetermined) {
        [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL granted) {
            dispatch_async(dispatch_get_main_queue(), ^{
                if (granted) [self startConversation];
                else [self setStatus:@"error" detail:@"Microphone permission was not granted."];
            });
        }];
    } else {
        [self setStatus:@"error" detail:@"Allow microphone access in System Settings → Privacy & Security → Microphone."];
    }
}

- (void)startConversation {
    self.running = YES;
    self.startButton.title = @"Stop voice chat";
    self.serverField.enabled = NO;
    self.tokenField.enabled = NO;
    self.heartbeatTimer = [NSTimer scheduledTimerWithTimeInterval:5 target:self selector:@selector(sendHeartbeat:) userInfo:nil repeats:YES];
    [self beginListening];
}

- (void)stopConversation {
    self.running = NO;
    self.localGeneration += 1;
    [self.turnTask cancel];
    self.turnTask = nil;
    [self.meterTimer invalidate];
    [self.heartbeatTimer invalidate];
    self.meterTimer = nil;
    self.heartbeatTimer = nil;
    [self.recorder stop];
    [self.player stop];
    self.recorder = nil;
    self.player = nil;
    self.startButton.title = @"Start voice chat";
    self.serverField.enabled = YES;
    self.tokenField.enabled = YES;
    [self setStatus:@"stopped" detail:@"Voice chat is off."];
    [self sendRemoteStatus];
}

- (void)flushCurrentTurn:(id)sender {
    [self saveSettings];
    NSMutableURLRequest *request = [self requestForPath:@"/api/remote/flush" method:@"POST"];
    if (!request || self.tokenField.stringValue.length == 0) {
        [self setStatus:@"error" detail:@"Enter the private AI address and access token."];
        return;
    }

    self.localGeneration += 1;
    [self.meterTimer invalidate];
    self.meterTimer = nil;
    [self.turnTask cancel];
    self.turnTask = nil;
    [self.recorder stop];
    [self.player stop];
    self.recorder = nil;
    self.player = nil;
    self.flushButton.enabled = NO;
    [self setStatus:@"flushing" detail:@"Cancelling work on this Mac and the Mac Ultra…"];

    [[[NSURLSession sharedSession] dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
        NSString *message = error.localizedDescription ?: [self errorMessageFromData:data fallback:[NSString stringWithFormat:@"Mac Ultra returned %ld", (long)http.statusCode]];
        dispatch_async(dispatch_get_main_queue(), ^{
            self.flushButton.enabled = YES;
            if (error || http.statusCode != 200) {
                [self setStatus:@"error" detail:message];
                return;
            }
            self.transcriptLabel.stringValue = @"—";
            self.replyLabel.stringValue = @"—";
            if (self.running) {
                [self setStatus:@"ready" detail:@"Flushed. Resuming listening…"];
                [self beginListening];
            } else {
                [self setStatus:@"stopped" detail:@"Current turn flushed. Voice chat is off."];
            }
        });
    }] resume];
}

- (void)beginListening {
    if (!self.running) return;
    self.recordingURL = [NSURL fileURLWithPath:[NSTemporaryDirectory() stringByAppendingPathComponent:@"talking-skelly-remote-visitor.wav"]];
    NSDictionary *settings = @{
        AVFormatIDKey: @(kAudioFormatLinearPCM),
        AVSampleRateKey: @16000,
        AVNumberOfChannelsKey: @1,
        AVLinearPCMBitDepthKey: @16,
        AVLinearPCMIsFloatKey: @NO,
        AVLinearPCMIsBigEndianKey: @NO
    };
    NSError *error = nil;
    self.recorder = [[AVAudioRecorder alloc] initWithURL:self.recordingURL settings:settings error:&error];
    self.recorder.meteringEnabled = YES;
    if (!self.recorder || ![self.recorder prepareToRecord] || ![self.recorder record]) {
        [self handleRecoverableError:error.localizedDescription ?: @"Could not open the selected microphone."];
        return;
    }
    self.heardSpeech = NO;
    self.speechCandidateStarted = 0;
    self.speechStarted = 0;
    self.silenceStarted = 0;
    BOOL needsCalibration = self.noiseSampleCount == 0;
    if (needsCalibration) self.noiseFloorDb = -55.0;
    self.listeningStarted = [NSDate timeIntervalSinceReferenceDate];
    [self setStatus:@"listening" detail:needsCalibration ? @"Calibrating for background noise…" : @"Waiting for a visitor"];
    [self sendRemoteStatus];
    self.meterTimer = [NSTimer scheduledTimerWithTimeInterval:0.10 target:self selector:@selector(checkMicrophone:) userInfo:nil repeats:YES];
}

- (void)checkMicrophone:(NSTimer *)timer {
    [self.recorder updateMeters];
    float power = [self.recorder averagePowerForChannel:0];
    float peak = [self.recorder peakPowerForChannel:0];
    NSTimeInterval now = [NSDate timeIntervalSinceReferenceDate];

    NSTimeInterval listeningAge = now - self.listeningStarted;
    // Learn the local noise level instead of treating one loud gust or bump as speech.
    // The EMEET's automatic gain can move this floor considerably when it is outdoors.
    if (self.noiseSampleCount < 12 && listeningAge < 1.2) {
        self.noiseSampleCount += 1;
        if (self.noiseSampleCount == 1) self.noiseFloorDb = power;
        else self.noiseFloorDb += (power - self.noiseFloorDb) / self.noiseSampleCount;
        return;
    }
    if (!self.heardSpeech && self.speechCandidateStarted == 0) {
        self.noiseFloorDb = (self.noiseFloorDb * 0.96f) + (power * 0.04f);
    }
    if ([self.currentDetail containsString:@"Calibrating"]) {
        [self setStatus:@"listening" detail:@"Waiting for a visitor"];
        [self sendRemoteStatus];
    }

    float speechThreshold = fminf(-12.0f, fmaxf(-38.0f, self.noiseFloorDb + 10.0f));
    float releaseThreshold = speechThreshold - 5.0f;
    BOOL speechLike = power > speechThreshold && (peak - power) >= 3.0f;

    if (!self.heardSpeech && speechLike) {
        if (self.speechCandidateStarted == 0) self.speechCandidateStarted = now;
        if (now - self.speechCandidateStarted >= 0.35) {
            self.heardSpeech = YES;
            self.speechStarted = self.speechCandidateStarted;
            self.silenceStarted = 0;
            [self setStatus:@"listening" detail:@"Visitor detected…"];
            [self sendRemoteStatus];
        }
    } else if (!self.heardSpeech) {
        self.speechCandidateStarted = 0;
    } else if (power > releaseThreshold) {
        self.silenceStarted = 0;
    } else {
        if (self.silenceStarted == 0) self.silenceStarted = now;
        else if (now - self.silenceStarted >= 1.1) {
            [self finishRecordingAndSend];
            return;
        }
    }

    // Bound every submitted turn so constant noise can never create a huge Whisper job.
    if (self.heardSpeech && now - self.speechStarted >= 15.0) {
        [self finishRecordingAndSend];
        return;
    }

    if (listeningAge >= 45) {
        [self.meterTimer invalidate];
        [self.recorder stop];
        self.recorder = nil;
        [self beginListening];
    }
}

- (void)finishRecordingAndSend {
    [self.meterTimer invalidate];
    self.meterTimer = nil;
    [self.recorder stop];
    self.recorder = nil;
    NSData *audio = [NSData dataWithContentsOfURL:self.recordingURL];
    if (audio.length < 1000) {
        [self beginListening];
        return;
    }

    [self setStatus:@"thinking" detail:@"The Mac Ultra is answering…"];
    [self sendRemoteStatus];
    NSUInteger generation = self.localGeneration;
    NSMutableURLRequest *request = [self requestForPath:@"/api/remote/turn" method:@"POST"];
    [request setValue:@"audio/wav" forHTTPHeaderField:@"Content-Type"];
    NSTimeInterval speechOffset = fmax(0.0, self.speechStarted - self.listeningStarted - 0.30);
    [request setValue:[NSString stringWithFormat:@"%.2f", speechOffset] forHTTPHeaderField:@"X-Skelly-Speech-Offset"];
    request.HTTPBody = audio;
    self.turnTask = [[NSURLSession sharedSession] dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
        if (generation != self.localGeneration) return;
        NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
        if (error || http.statusCode != 200 || ![[http valueForHTTPHeaderField:@"Content-Type"] hasPrefix:@"audio/wav"]) {
            NSString *message = error.localizedDescription ?: [self errorMessageFromData:data fallback:[NSString stringWithFormat:@"Mac Ultra returned %ld", (long)http.statusCode]];
            dispatch_async(dispatch_get_main_queue(), ^{
                if (generation != self.localGeneration) return;
                self.turnTask = nil;
                [self handleRecoverableError:message];
            });
            return;
        }
        NSString *transcript = [self decodeHeader:[http valueForHTTPHeaderField:@"X-Skelly-Transcript"]];
        NSString *reply = [self decodeHeader:[http valueForHTTPHeaderField:@"X-Skelly-Reply"]];
        dispatch_async(dispatch_get_main_queue(), ^{
            if (generation != self.localGeneration) return;
            self.turnTask = nil;
            self.transcriptLabel.stringValue = transcript.length ? transcript : @"—";
            self.replyLabel.stringValue = reply.length ? reply : @"—";
            [self playResponse:data];
        });
    }];
    [self.turnTask resume];
}

- (NSString *)decodeHeader:(NSString *)value {
    if (!value.length) return @"";
    NSMutableString *base64 = [value mutableCopy];
    [base64 replaceOccurrencesOfString:@"-" withString:@"+" options:0 range:NSMakeRange(0, base64.length)];
    [base64 replaceOccurrencesOfString:@"_" withString:@"/" options:0 range:NSMakeRange(0, base64.length)];
    while (base64.length % 4) [base64 appendString:@"="];
    NSData *data = [[NSData alloc] initWithBase64EncodedString:base64 options:0];
    return data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : @"";
}

- (void)playResponse:(NSData *)audio {
    NSError *error = nil;
    self.player = [[AVAudioPlayer alloc] initWithData:audio error:&error];
    if (!self.player) {
        [self handleRecoverableError:error.localizedDescription ?: @"Could not play Skelly's response."];
        return;
    }
    self.player.delegate = self;
    [self setStatus:@"speaking" detail:@"Skelly is talking"];
    [self sendRemoteStatus];
    [self.player play];
}

- (void)audioPlayerDidFinishPlaying:(AVAudioPlayer *)player successfully:(BOOL)flag {
    if (player != self.player) return;
    self.player = nil;
    if (!self.running) return;

    // Bluetooth speakers can continue emitting buffered audio after local playback
    // reports completion. Wait for that tail to clear so Skelly cannot hear himself.
    NSUInteger generation = self.localGeneration;
    [self setStatus:@"ready" detail:@"Letting Skelly's speaker finish…"];
    [self sendRemoteStatus];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        if (self.running && generation == self.localGeneration && self.player == nil) [self beginListening];
    });
}

- (void)handleRecoverableError:(NSString *)message {
    [self setStatus:@"error" detail:message];
    self.currentState = @"error";
    self.currentDetail = message;
    [self sendRemoteStatus];
    NSUInteger generation = self.localGeneration;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3.0 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        if (self.running && generation == self.localGeneration) [self beginListening];
    });
}

- (void)sendHeartbeat:(NSTimer *)timer {
    [self sendRemoteStatus];
}

- (void)sendRemoteStatus {
    if (!self.baseURL.length || !self.tokenField.stringValue.length) return;
    NSMutableURLRequest *request = [self requestForPath:@"/api/remote/status" method:@"POST"];
    [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
    NSString *state = self.running ? (self.currentState ?: @"online") : @"offline";
    NSDictionary *body = @{ @"state": state, @"detail": self.currentDetail ?: @"", @"client": @"Mac Remote" };
    request.HTTPBody = [NSJSONSerialization dataWithJSONObject:body options:0 error:nil];
    [[[NSURLSession sharedSession] dataTaskWithRequest:request] resume];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender { return YES; }

- (void)applicationWillTerminate:(NSNotification *)notification {
    if (self.running) [self stopConversation];
}

@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSApplication *application = NSApplication.sharedApplication;
        SkellyRemoteDelegate *delegate = [[SkellyRemoteDelegate alloc] init];
        application.delegate = delegate;
        [application run];
    }
    return 0;
}
