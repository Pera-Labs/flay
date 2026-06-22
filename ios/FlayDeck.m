#import "FlayDeck.h"
#import <React/RCTBridge.h>
#import <React/RCTRootView.h>
#import <objc/message.h>
#import <objc/runtime.h>

static UIWindow *_flayOverlayWindow = nil;
static void (*_flay_orig_motionEnded)(id, SEL, NSInteger, UIEvent *) = NULL;

static void _flay_swizzled_motionEnded(id self, SEL _cmd, NSInteger motion, UIEvent *event) {
  if (motion == UIEventSubtypeMotionShake) {
    [[NSNotificationCenter defaultCenter] postNotificationName:@"FlayOpen" object:nil];
  }
  if (_flay_orig_motionEnded) _flay_orig_motionEnded(self, _cmd, motion, event);
}

@interface FlayDeck () <UIGestureRecognizerDelegate>
@property (nonatomic, weak) UIViewController *host;
@end

@implementation FlayDeck

+ (instancetype)shared {
  static FlayDeck *s = nil;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ s = [FlayDeck new]; });
  return s;
}

+ (void)install {
  FlayDeck *s = [FlayDeck shared];
  [[NSNotificationCenter defaultCenter] addObserver:s selector:@selector(_onActive) name:UIApplicationDidBecomeActiveNotification object:nil];
  [[NSNotificationCenter defaultCenter] addObserver:s selector:@selector(_onScreenshot) name:UIApplicationUserDidTakeScreenshotNotification object:nil];
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    Method m = class_getInstanceMethod([UIWindow class], @selector(motionEnded:withEvent:));
    if (m) {
      _flay_orig_motionEnded = (void (*)(id, SEL, NSInteger, UIEvent *))method_getImplementation(m);
      method_setImplementation(m, (IMP)_flay_swizzled_motionEnded);
    }
  });
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{ [s attach]; });
}

- (void)_onScreenshot {
  [[NSNotificationCenter defaultCenter] postNotificationName:@"FlayOpen" object:nil];
}

- (void)_onActive {
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{ [self attach]; });
}

- (void)attach {
  UIWindow *win = nil;
  if (@available(iOS 13.0, *)) {
    for (UIScene *sc in [UIApplication sharedApplication].connectedScenes) {
      if ([sc isKindOfClass:[UIWindowScene class]]) {
        for (UIWindow *w in ((UIWindowScene *)sc).windows) {
          if (w.isKeyWindow) { win = w; break; }
        }
        if (win) break;
      }
    }
  }
  if (!win) win = [UIApplication sharedApplication].keyWindow;
  UIViewController *rvc = win.rootViewController;
  if (!rvc || !rvc.view.window) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{ [self attach]; });
    return;
  }
  for (UIGestureRecognizer *gr in rvc.view.gestureRecognizers) {
    if ([gr isKindOfClass:[UIPinchGestureRecognizer class]] && gr.delegate == self) return;
  }
  self.host = rvc;
  UIPinchGestureRecognizer *pinch = [[UIPinchGestureRecognizer alloc] initWithTarget:self action:@selector(_onPinch:)];
  pinch.delegate = self;
  pinch.cancelsTouchesInView = NO;
  [rvc.view addGestureRecognizer:pinch];
  NSLog(@"[FlayDeck] attached to %@", NSStringFromClass([rvc class]));
}

- (BOOL)gestureRecognizer:(UIGestureRecognizer *)g shouldRecognizeSimultaneouslyWithGestureRecognizer:(UIGestureRecognizer *)other {
  return YES;
}

- (void)_onPinch:(UIPinchGestureRecognizer *)g {
  if (g.state != UIGestureRecognizerStateEnded) return;
  if (g.scale > 1.15 || g.scale < 0.85) {
    [[NSNotificationCenter defaultCenter] postNotificationName:@"FlayOpen" object:nil];
  }
}

+ (UIWindowScene *)_activeScene API_AVAILABLE(ios(13.0)) {
  for (UIScene *sc in [UIApplication sharedApplication].connectedScenes) {
    if ([sc isKindOfClass:[UIWindowScene class]] && sc.activationState == UISceneActivationStateForegroundActive) return (UIWindowScene *)sc;
  }
  for (UIScene *sc in [UIApplication sharedApplication].connectedScenes) {
    if ([sc isKindOfClass:[UIWindowScene class]]) return (UIWindowScene *)sc;
  }
  return nil;
}

+ (void)presentOverlayWithBridge:(RCTBridge *)bridge {
  NSLog(@"[FlayDeck] presentOverlayWithBridge bridge=%@ existing=%@", bridge, _flayOverlayWindow);
  if (_flayOverlayWindow) { _flayOverlayWindow.hidden = NO; return; }
  RCTBridge *real = bridge;
  if (real && [real respondsToSelector:@selector(bridge)]) {
    id maybe = [(id)real performSelector:@selector(bridge)];
    if ([maybe isKindOfClass:[RCTBridge class]]) real = (RCTBridge *)maybe;
  }
  if (!real || ![real isKindOfClass:[RCTBridge class]]) {
    SEL cb = NSSelectorFromString(@"currentBridge");
    if ([[RCTBridge class] respondsToSelector:cb]) {
      id b = ((id(*)(id, SEL))objc_msgSend)([RCTBridge class], cb);
      if ([b isKindOfClass:[RCTBridge class]]) real = (RCTBridge *)b;
    }
  }
  NSLog(@"[FlayDeck] resolved real bridge=%@", real);
  if (!real) { NSLog(@"[FlayDeck] ABORT: real bridge nil"); return; }
  RCTRootView *rv = [[RCTRootView alloc] initWithBridge:real moduleName:@"FlayOverlay" initialProperties:nil];
  rv.backgroundColor = [UIColor clearColor];
  UIViewController *vc = [UIViewController new];
  vc.view.backgroundColor = [UIColor clearColor];
  rv.frame = [UIScreen mainScreen].bounds;
  rv.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
  [vc.view addSubview:rv];
  UIWindow *w = nil;
  if (@available(iOS 13.0, *)) {
    UIWindowScene *sc = [self _activeScene];
    if (sc) w = [[UIWindow alloc] initWithWindowScene:sc];
  }
  if (!w) w = [[UIWindow alloc] initWithFrame:[UIScreen mainScreen].bounds];
  w.windowLevel = UIWindowLevelAlert + 1;
  w.backgroundColor = [UIColor clearColor];
  w.rootViewController = vc;
  w.hidden = NO;
  _flayOverlayWindow = w;
  NSLog(@"[FlayDeck] overlay window presented");
}

+ (void)dismissOverlay {
  if (!_flayOverlayWindow) return;
  _flayOverlayWindow.hidden = YES;
  _flayOverlayWindow.rootViewController = nil;
  _flayOverlayWindow = nil;
}

@end
