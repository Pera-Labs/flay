#import "FlayBridge.h"
#import "FlayDeck.h"

static BOOL _flayHasListeners = NO;

@implementation FlayBridge

RCT_EXPORT_MODULE(FlayBridge);

+ (BOOL)requiresMainQueueSetup { return NO; }

- (instancetype)init {
  if ((self = [super init])) {
    [[NSNotificationCenter defaultCenter] addObserver:self
                                             selector:@selector(_onOpen:)
                                                 name:@"FlayOpen"
                                               object:nil];
  }
  return self;
}

- (void)dealloc {
  [[NSNotificationCenter defaultCenter] removeObserver:self];
}

- (NSArray<NSString *> *)supportedEvents {
  return @[@"FlayOpen"];
}

- (void)startObserving { _flayHasListeners = YES; }
- (void)stopObserving  { _flayHasListeners = NO; }

- (void)_onOpen:(NSNotification *)n {
  if (!_flayHasListeners) return;
  NSDictionary *info = n.userInfo ?: @{};
  [self sendEventWithName:@"FlayOpen" body:info];
}

RCT_EXPORT_METHOD(present) {
  RCTBridge *b = self.bridge;
  NSLog(@"[FlayDeck] present called bridge=%@", b);
  dispatch_async(dispatch_get_main_queue(), ^{
    [FlayDeck presentOverlayWithBridge:b];
  });
}

RCT_EXPORT_METHOD(dismiss) {
  dispatch_async(dispatch_get_main_queue(), ^{
    [FlayDeck dismissOverlay];
  });
}

RCT_EXPORT_METHOD(captureScreenshot:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    UIWindow *target = nil;
    if (@available(iOS 13.0, *)) {
      for (UIScene *scene in [UIApplication sharedApplication].connectedScenes) {
        if (scene.activationState == UISceneActivationStateForegroundActive &&
            [scene isKindOfClass:[UIWindowScene class]]) {
          for (UIWindow *w in ((UIWindowScene *)scene).windows) {
            if (w.isKeyWindow) { target = w; break; }
          }
          if (!target) {
            UIWindowScene *ws = (UIWindowScene *)scene;
            if (ws.windows.count > 0) target = ws.windows.firstObject;
          }
          if (target) break;
        }
      }
    }
    if (!target) target = [UIApplication sharedApplication].keyWindow;
    if (!target) { resolve((id)kCFNull); return; }

    CGSize size = target.bounds.size;
    UIGraphicsImageRendererFormat *fmt = [UIGraphicsImageRendererFormat defaultFormat];
    fmt.opaque = YES;
    fmt.scale = MIN(target.screen.scale, 2.0);
    UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc] initWithSize:size format:fmt];
    UIImage *img = [renderer imageWithActions:^(UIGraphicsImageRendererContext *ctx) {
      [target drawViewHierarchyInRect:CGRectMake(0, 0, size.width, size.height) afterScreenUpdates:NO];
    }];
    NSData *jpeg = UIImageJPEGRepresentation(img, 0.6);
    if (!jpeg) { resolve((id)kCFNull); return; }
    NSString *b64 = [jpeg base64EncodedStringWithOptions:0];
    NSString *uri = [@"data:image/jpeg;base64," stringByAppendingString:b64];
    resolve(uri);
  });
}

@end
