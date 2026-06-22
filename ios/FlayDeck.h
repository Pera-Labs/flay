#import <UIKit/UIKit.h>
@class RCTBridge;

NS_ASSUME_NONNULL_BEGIN

@interface FlayDeck : NSObject

+ (void)install;
+ (void)presentOverlayWithBridge:(RCTBridge *)bridge;
+ (void)dismissOverlay;

@end

NS_ASSUME_NONNULL_END
