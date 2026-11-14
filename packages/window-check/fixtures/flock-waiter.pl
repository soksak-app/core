# Opens the file of its first argument, prints "opened", and then waits for an exclusive flock on it.
use Fcntl ":flock";
$| = 1;
open(my $f, "<", $ARGV[0]) or die;
print "opened\n";
flock($f, LOCK_EX) or die;
sleep 60;
